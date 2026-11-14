import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { CampaignInput, CampaignPreview, PushCampaigns } from '../contracts/campaigns.js';

type Db = Database | TransactionContext;
type Device = { id: string; user_id: string; app: string; updated_at: string };
function validate(input: CampaignPreview): void {
  const t = input.target;
  if (
    !t ||
    !Array.isArray(t.apps) ||
    !t.apps.length ||
    t.apps.some((x) => !['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'].includes(x)) ||
    !['PROMOTIONAL', 'OPERATIONAL'].includes(input.kind)
  )
    throw new Error('INVALID_INPUT');
  if (
    t.mode === 'USERS'
      ? !t.userIds?.length || !!t.platform
      : t.mode === 'PLATFORM'
        ? !t.platform || !!t.userIds
        : t.mode !== 'ALL' || !!t.userIds || !!t.platform
  )
    throw new Error('INVALID_INPUT');
  if (
    t.userIds &&
    (t.userIds.length > 1000 || t.userIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
  )
    throw new Error('INVALID_INPUT');
}
function validateMessage(input: CampaignInput): void {
  validate(input);
  if (
    !input.title?.trim() ||
    !input.body?.trim() ||
    input.title.length > 100 ||
    input.body.length > 500
  )
    throw new Error('INVALID_INPUT');
  if (input.clickAction) {
    const x = input.clickAction;
    if (
      [...x].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\') ||
      x.startsWith('//')
    )
      throw new Error('INVALID_INPUT');
    if (!x.startsWith('/')) {
      try {
        const u = new URL(x);
        if (u.protocol !== 'https:' || u.username || u.password) throw new Error();
      } catch {
        throw new Error('INVALID_INPUT');
      }
    }
  }
  if (input.imageUrl) {
    try {
      const u = new URL(input.imageUrl);
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error();
    } catch {
      throw new Error('INVALID_INPUT');
    }
  }
  const entries = Object.entries(input.data ?? {});
  if (
    entries.length > 10 ||
    entries.some(
      ([k, v]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) ||
        /^(google|gcm)/i.test(k) ||
        [
          'from',
          'notification',
          'message_type',
          'messageid',
          'notificationid',
          'collapsekey',
          'link',
          'clickaction',
          '__proto__',
          'constructor',
          'prototype',
        ].includes(k.toLowerCase()) ||
        typeof v !== 'string' ||
        v.length > 256,
    )
  )
    throw new Error('INVALID_INPUT');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 3500) throw new Error('INVALID_INPUT');
}
async function devices(db: Db, input: CampaignPreview): Promise<Device[]> {
  validate(input);
  const target = input.target;
  const result =
    await sql<Device>`SELECT d.id,d.user_id,d.app,d.updated_at::text AS updated_at FROM device_tokens d JOIN users u ON u.id=d.user_id WHERE u.status='ACTIVE' AND d.active AND d.platform IN ('ANDROID','WEB') AND d.app=ANY(${target.apps}::text[]) AND (${target.mode !== 'USERS'} OR d.user_id=ANY(${target.userIds ?? []}::uuid[])) AND (${target.mode !== 'PLATFORM'} OR d.platform=${target.platform ?? null}) AND (${input.kind !== 'PROMOTIONAL'} OR NOT EXISTS (SELECT 1 FROM notification_preferences p WHERE p.user_id=d.user_id AND p.category='PROMOTIONS' AND NOT p.enabled)) ORDER BY d.id LIMIT 10001`.execute(
      db,
    );
  if (result.rows.length > 10000) throw new Error('INVALID_INPUT');
  return result.rows;
}
export class PostgresPushCampaigns implements PushCampaigns {
  constructor(private readonly db: Database) {}
  async preview(input: CampaignPreview) {
    const rows = await devices(this.db, input);
    return { devices: rows.length, users: new Set(rows.map((x) => x.user_id)).size };
  }
  async create(actor: string, key: string, input: CampaignInput) {
    validateMessage(input);
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new Error('INVALID_INPUT');
    const canonical = {
      ...input,
      target: {
        ...input.target,
        apps: [...new Set(input.target.apps)].sort(),
        ...(input.target.userIds ? { userIds: [...new Set(input.target.userIds)].sort() } : {}),
      },
      data: Object.fromEntries(
        Object.entries(input.data ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor + ':' + key},0))`.execute(tx);
      const old = await sql<{
        id: string;
        request_hash: string;
      }>`SELECT id,request_hash FROM push_campaigns WHERE created_by=${actor}::uuid AND idempotency_key=${key}`.execute(
        tx,
      );
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash)
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return { id: old.rows[0].id, replay: true };
      }
      const allowed =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actor}::uuid AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') LIMIT 1`.execute(
          tx,
        );
      if (!allowed.rows.length) throw new Error('FORBIDDEN');
      const rows = await devices(tx, input);
      if (!rows.length) throw new Error('INVALID_INPUT');
      const id = uuidV7();
      await sql`INSERT INTO push_campaigns(id,created_by,idempotency_key,request_hash,target,payload) VALUES (${id}::uuid,${actor}::uuid,${key},${hash},${JSON.stringify(canonical.target)}::jsonb,${JSON.stringify(canonical)}::jsonb)`.execute(
        tx,
      );
      const groups = new Map<string, Device[]>();
      for (const row of rows) {
        const k = row.user_id + '|' + row.app;
        const group = groups.get(k) ?? [];
        group.push(row);
        groups.set(k, group);
      }
      const notices: {
        id: string;
        user_id: string;
        delivery_id: string;
        payload: string;
        dedupe: string;
      }[] = [];
      const snapshot: {
        notification_id: string;
        user_id: string;
        token_id: string;
        token_updated_at: string;
      }[] = [];
      for (const group of groups.values()) {
        const user = group[0]!.user_id,
          app = group[0]!.app,
          nid = uuidV7(),
          did = uuidV7();
        const payload = {
          campaignId: id,
          app,
          title: input.title,
          body: input.body,
          deepLink: input.clickAction ?? null,
          imageUrl: input.imageUrl ?? null,
          data: input.data ?? {},
          pushPriority: 'NORMAL',
        };
        notices.push({
          id: nid,
          user_id: user,
          delivery_id: did,
          payload: JSON.stringify(payload),
          dedupe: 'campaign|' + id + '|' + user + '|' + app,
        });
        for (const device of group)
          snapshot.push({
            notification_id: nid,
            user_id: user,
            token_id: device.id,
            token_updated_at: device.updated_at,
          });
      }
      await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,status,dedupe_key)
        SELECT x.id,x.user_id,'PUSH','campaign.manual','en',${input.kind === 'PROMOTIONAL' ? 'PROMOTIONS' : 'ADMIN'},${input.kind === 'PROMOTIONAL' ? 'PROMOTIONAL' : 'TRANSACTIONAL'},x.payload::jsonb,'PENDING',x.dedupe FROM jsonb_to_recordset(${JSON.stringify(notices)}::jsonb) AS x(id uuid,user_id uuid,payload text,dedupe text)`.execute(
        tx,
      );
      await sql`INSERT INTO notification_deliveries(id,notification_id,channel)
        SELECT x.delivery_id,x.id,'PUSH' FROM jsonb_to_recordset(${JSON.stringify(notices)}::jsonb) AS x(id uuid,delivery_id uuid)`.execute(
        tx,
      );
      await sql`INSERT INTO push_campaign_targets(campaign_id,notification_id,user_id,token_id,token_updated_at)
        SELECT ${id}::uuid,x.notification_id,x.user_id,x.token_id,x.token_updated_at FROM jsonb_to_recordset(${JSON.stringify(snapshot)}::jsonb) AS x(notification_id uuid,user_id uuid,token_id uuid,token_updated_at timestamptz)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${actor}::uuid,'PUSH_CAMPAIGN_CREATED','push_campaign',${id})`.execute(
        tx,
      );
      return { id, replay: false, devices: rows.length };
    });
  }
  async list(cursor?: string) {
    if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) throw new Error('INVALID_INPUT');
    const rows =
      await sql`SELECT id,created_by,created_at,target FROM push_campaigns WHERE (${cursor ?? null}::uuid IS NULL OR id<${cursor ?? null}::uuid) ORDER BY id DESC LIMIT 51`.execute(
        this.db,
      );
    return {
      items: rows.rows.slice(0, 50),
      nextCursor: rows.rows.length > 50 ? (rows.rows[49] as { id: string }).id : null,
    };
  }
  async detail(id: string, cursor?: string) {
    if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) throw new Error('INVALID_INPUT');
    const campaign =
      await sql`SELECT id,created_by,created_at,target,payload FROM push_campaigns WHERE id=${id}::uuid`.execute(
        this.db,
      );
    if (!campaign.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    const results =
      await sql`SELECT COALESCE(r.status, CASE WHEN n.status IN ('FAILED','SKIPPED') THEN n.status ELSE 'PENDING' END) AS status,count(*)::int AS devices FROM push_campaign_targets t JOIN notifications n ON n.id=t.notification_id JOIN notification_deliveries d ON d.notification_id=n.id LEFT JOIN notification_token_results r ON r.delivery_id=d.id AND r.token_id=t.token_id WHERE t.campaign_id=${id}::uuid GROUP BY 1`.execute(
        this.db,
      );
    const deliveries = await sql<{
      token_id: string;
    }>`SELECT t.token_id,t.user_id,d.platform,d.app,COALESCE(r.status, CASE WHEN n.status IN ('FAILED','SKIPPED') THEN n.status ELSE 'PENDING' END) AS status,r.error,n.sent_at FROM push_campaign_targets t JOIN device_tokens d ON d.id=t.token_id JOIN notifications n ON n.id=t.notification_id JOIN notification_deliveries nd ON nd.notification_id=n.id LEFT JOIN notification_token_results r ON r.delivery_id=nd.id AND r.token_id=t.token_id WHERE t.campaign_id=${id}::uuid AND (${cursor ?? null}::uuid IS NULL OR t.token_id>${cursor ?? null}::uuid) ORDER BY t.token_id LIMIT 101`.execute(
      this.db,
    );
    return {
      ...campaign.rows[0],
      results: results.rows,
      deliveries: deliveries.rows.slice(0, 100),
      nextCursor: deliveries.rows.length > 100 ? deliveries.rows[99]!.token_id : null,
    };
  }
}
