import { createReadStream } from 'node:fs';
import { Logger } from '@nestjs/common';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { StoragePort } from '../../media/contracts/storage.js';
import type { ExportFilters } from '../contracts/exports.js';
import type { ReportData, ReportKind } from '../contracts/report-data.js';
import { csvLine } from '../domain/csv.js';

interface ExportJob {
  id: string;
  owner_id: string;
  audience: 'ADMIN' | 'CUSTOMER';
  kind: string;
  filters: ExportFilters;
}
export class ExportWorker {
  private readonly logger = new Logger(ExportWorker.name);
  constructor(
    private readonly db: Database,
    private readonly storage: StoragePort,
    private readonly config: AppConfig,
    private readonly reports: ReportData,
  ) {}
  async cleanup(): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const expired = await sql<{
        id: string;
        object_key: string;
      }>`SELECT id,object_key FROM compliance_export_jobs WHERE status='COMPLETE' AND expires_at<=clock_timestamp() AND object_key IS NOT NULL ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100`.execute(
        tx,
      );
      for (const row of expired.rows) {
        await sql`INSERT INTO compliance_export_objects(object_key,job_id,remove_after) VALUES (${row.object_key},${row.id}::uuid,clock_timestamp()) ON CONFLICT(object_key) DO UPDATE SET remove_after=LEAST(compliance_export_objects.remove_after,EXCLUDED.remove_after)`.execute(
          tx,
        );
        await sql`UPDATE compliance_export_jobs SET status='EXPIRED',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
          tx,
        );
      }
    });
    const objects = await sql<{
      object_key: string;
    }>`SELECT object_key FROM compliance_export_objects WHERE remove_after<=clock_timestamp() ORDER BY remove_after,object_key LIMIT 100`.execute(
      this.db,
    );
    for (const object of objects.rows) {
      await this.storage.remove(object.object_key);
      await sql`DELETE FROM compliance_export_objects WHERE object_key=${object.object_key}`.execute(
        this.db,
      );
    }
  }
  async runOne(): Promise<boolean> {
    const lease = uuidV7(),
      keySuffix = uuidV7();
    const job = await this.db.transaction().execute(async (tx) => {
      const result =
        await sql<ExportJob>`SELECT id,owner_id,audience,kind,filters FROM compliance_export_jobs WHERE (status='QUEUED' AND retry_after<=clock_timestamp()) OR (status='RUNNING' AND lease_until<=clock_timestamp()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`.execute(
          tx,
        );
      const row = result.rows[0];
      if (!row) return null;
      const key = `private/${row.id}/${keySuffix}`;
      await sql`UPDATE compliance_export_jobs SET status='RUNNING',lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '30 minutes',object_key=${key},row_count=0,attempts=attempts+1,updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO compliance_export_objects(object_key,job_id,remove_after) VALUES (${key},${row.id}::uuid,clock_timestamp()+interval '30 minutes')`.execute(
        tx,
      );
      return { ...row, key };
    });
    if (!job) return false;
    const maxRows = await this.config.get('reportExportMaxRows');
    const maxBytes = await this.config.get('reportExportMaxBytes');
    const timeout = await this.config.get('reportExportTimeoutSeconds');
    const retention = await this.config.get('reportExportRetentionDays');
    const deadline = Date.now() + timeout * 1000;
    const signal = AbortSignal.timeout(timeout * 1000);
    const directory = await mkdtemp(join(tmpdir(), 'delivery-compliance-'));
    const path = join(directory, 'export.csv');
    let count = 0,
      bytes = 0;
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await this.db.transaction().execute(async (tx) => {
          await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(tx);
          await sql`SELECT set_config('statement_timeout',${`${timeout * 1000}ms`},true)`.execute(
            tx,
          );
          let cursor: string | null = null,
            first = true;
          do {
            if (signal.aborted || Date.now() >= deadline) throw new Error('REPORT_TIMEOUT');
            const page: { rows: Record<string, unknown>[]; nextCursor: string | null } =
              job.audience === 'CUSTOMER'
                ? await this.personalPage(job.owner_id, cursor, tx)
                : await this.reports.page(job.kind as ReportKind, cursor, 500, tx, job.filters);
            if (first && page.rows.length) {
              const line = csvLine(Object.keys(page.rows[0]!));
              bytes += Buffer.byteLength(line);
              await file.write(line);
              first = false;
            }
            for (const row of page.rows) {
              if (++count > maxRows) throw new Error('REPORT_TOO_LARGE');
              const line = csvLine(Object.values(row));
              bytes += Buffer.byteLength(line);
              if (bytes > maxBytes) throw new Error('REPORT_TOO_LARGE');
              await file.write(line);
            }
            cursor = page.nextCursor;
          } while (cursor);
        });
      } finally {
        await file.close();
      }
      if (signal.aborted) throw new Error('REPORT_TIMEOUT');
      await this.storage.putPrivateStream(
        job.key,
        createReadStream(path),
        'text/csv; charset=utf-8',
        { maxBytes, signal },
      );
      await this.db.transaction().execute(async (tx) => {
        const owner =
          await sql`SELECT id FROM users WHERE id=${job.owner_id}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
            tx,
          );
        if (!owner.rows.length) throw new Error('ACCOUNT_DISABLED');
        const saved =
          await sql`UPDATE compliance_export_jobs SET status='COMPLETE',row_count=${count},lease_token=NULL,lease_until=NULL,expires_at=clock_timestamp()+${retention}*interval '1 day',updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND status='RUNNING' AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() RETURNING id`.execute(
            tx,
          );
        if (!saved.rows.length) throw new Error('REPORT_LEASE_LOST');
        await sql`DELETE FROM compliance_export_objects WHERE object_key=${job.key}`.execute(tx);
      });
    } catch {
      this.logger.error(`Export job ${job.id} failed; recovery will retry`);
      await sql`UPDATE compliance_export_jobs SET status=CASE WHEN attempts<3 THEN 'QUEUED' ELSE 'FAILED' END,retry_after=clock_timestamp()+power(2,LEAST(attempts,8))*interval '1 second',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND status='RUNNING' AND lease_token=${lease}::uuid`
        .execute(this.db)
        .catch(() => undefined);
      await sql`UPDATE compliance_export_objects SET remove_after=clock_timestamp() WHERE object_key=${job.key}`
        .execute(this.db)
        .catch(() => undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return true;
  }
  private async personalPage(userId: string, cursor: string | null, tx: TransactionContext) {
    const split = cursor?.split(':') ?? [];
    if (
      cursor &&
      (split.length !== 2 || !/^[a-z_]+$/.test(split[0]!) || !/^[0-9a-f-]{36}$/i.test(split[1]!))
    )
      throw new Error('INVALID_CURSOR');
    const afterKind = split[0] ?? '',
      afterId = split[1] ?? '00000000-0000-0000-0000-000000000000';
    const result = await sql<{ category: string; id: string; data: unknown }>`WITH personal AS (
      SELECT 'profile'::text AS category,id,jsonb_build_object('name',name,'email',normalized_email,'emailVerified',email_verified,'consents',(SELECT COALESCE(jsonb_agg(jsonb_build_object('type',type,'version',version,'acceptedAt',accepted_at)),'[]'::jsonb) FROM consents WHERE user_id=${userId}::uuid)) AS data FROM users WHERE id=${userId}::uuid
      UNION ALL SELECT 'address',id,jsonb_build_object('line1',line1,'line2',line2,'landmark',landmark,'pincode',pincode,'contactName',contact_name,'contactPhone',contact_phone,'deletedAt',deleted_at) FROM addresses WHERE user_id=${userId}::uuid
      UNION ALL SELECT 'order',id,jsonb_build_object('status',status,'currency',currency,'totalPaise',total_paise::text,'placedAt',placed_at,'address',address_snapshot) FROM orders WHERE user_id=${userId}::uuid
      UNION ALL SELECT 'order_item',i.id,jsonb_build_object('orderId',i.order_id,'name',i.name_snapshot,'quantity',i.ordered_qty::text,'unitPricePaise',i.unit_price_paise::text) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.user_id=${userId}::uuid
      UNION ALL SELECT 'subscription',id,jsonb_build_object('status',status,'startDate',start_date,'endDate',end_date,'addressId',address_id) FROM subscriptions WHERE user_id=${userId}::uuid
      UNION ALL SELECT 'favorite',id,jsonb_build_object('productId',product_id,'createdAt',created_at) FROM customer_favorites WHERE user_id=${userId}::uuid AND active
      UNION ALL SELECT 'referral_code',user_id,jsonb_build_object('code',code,'createdAt',created_at) FROM referral_codes WHERE user_id=${userId}::uuid
      UNION ALL SELECT 'referral_claim',id,jsonb_build_object('role',CASE WHEN referrer_id=${userId}::uuid THEN 'referrer' ELSE 'friend' END,'createdAt',created_at,'creditExpiresAt',credit_expires_at,'freeDeliveryRedeemed',redeemed_order_id IS NOT NULL) FROM referral_claims WHERE referrer_id=${userId}::uuid OR friend_id=${userId}::uuid
      UNION ALL SELECT 'ticket',id,jsonb_build_object('category',category,'status',status,'orderId',order_id) FROM support_tickets WHERE owner_id=${userId}::uuid
      UNION ALL SELECT 'ticket_message',m.id,jsonb_build_object('ticketId',m.ticket_id,'body',m.body,'createdAt',m.created_at) FROM support_ticket_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE t.owner_id=${userId}::uuid AND NOT m.internal
      UNION ALL SELECT 'rating',id,jsonb_build_object('targetType',target_type,'targetId',target_id,'stars',stars,'comment',comment) FROM ratings WHERE rater_id=${userId}::uuid
      UNION ALL SELECT 'wallet',id,jsonb_build_object('cashBalancePaise',cash_balance_paise::text,'promoBalancePaise',promo_balance_paise::text) FROM wallet_accounts WHERE user_id=${userId}::uuid
      UNION ALL SELECT 'wallet_entry',l.id,jsonb_build_object('bucket',l.bucket,'deltaPaise',l.delta_paise::text,'reason',l.reason,'createdAt',l.created_at) FROM wallet_ledger l JOIN wallet_accounts w ON w.id=l.account_id WHERE w.user_id=${userId}::uuid
      UNION ALL SELECT 'notification',id,jsonb_build_object('category',category,'templateKey',template_key,'createdAt',created_at) FROM notifications WHERE user_id=${userId}::uuid
    ) SELECT category,id::text,data FROM personal WHERE (category,id)>(${afterKind},${afterId}::uuid) ORDER BY category,id LIMIT 501`.execute(
      tx,
    );
    const more = result.rows.length > 500,
      rows = result.rows.slice(0, 500),
      last = rows.at(-1);
    return {
      rows: rows.map((row) => ({
        category: row.category,
        id: row.id,
        data: JSON.stringify(row.data),
      })),
      nextCursor: more && last ? `${last.category}:${last.id}` : null,
    };
  }
}
