import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { hashRequest } from '../../../common/idempotency/idempotency.js';
import {
  transactionWithRetry,
  type Database,
  type Json,
} from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type {
  ApprovalFactory,
  ApprovalExecutor,
  ApprovalAction,
} from '../../compliance/contracts/approval.js';
import type { PaymentRefundOperations } from '../../payments/contracts/payments.js';
import type { OrderAdministration } from '../contracts/administration.js';
import type { OrderService } from './order-service.js';

type Request = {
  kind: 'REFUND' | 'REPAIR';
  orderId: string;
  reason: string;
  reference: string;
  amountPaise?: string;
  state?: 'CANCELLED' | 'EXPIRED';
};
function valid(payload: Json): boolean {
  const p = payload as unknown as Request;
  return (
    !!p &&
    /^[0-9a-f-]{36}$/i.test(p.orderId ?? '') &&
    typeof p.reason === 'string' &&
    p.reason.trim().length > 0 &&
    p.reason.length <= 300 &&
    typeof p.reference === 'string' &&
    p.reference.length <= 300 &&
    (p.kind === 'REFUND'
      ? /^[1-9]\d{0,17}$/.test(p.amountPaise ?? '')
      : p.kind === 'REPAIR' && ['CANCELLED', 'EXPIRED'].includes(p.state ?? ''))
  );
}
/** Money and state repair require different current maker/checker identities. */
export class OrderAdministrationService implements OrderAdministration {
  private readonly executor: ApprovalExecutor;
  private readonly action: ApprovalAction;
  constructor(
    factory: ApprovalFactory,
    orders: OrderService,
    refunds: PaymentRefundOperations,
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    const action: ApprovalAction = {
      version: 1,
      makerRole: 'ADMIN',
      checkerRole: 'SUPER_ADMIN',
      ttlSeconds: 86400,
      validate: valid,
      async execute(tx, payload, _executionKey, checkerId) {
        const p = payload as unknown as Request,
          hash = hashRequest(JSON.stringify(p));
        const order = await orders.byId(p.orderId, { tx });
        if (!order) throw new Error('ORDER_NOT_FOUND');
        await sql`SELECT id FROM orders WHERE id=${p.orderId}::uuid FOR UPDATE`.execute(tx);
        const inserted =
          await sql`INSERT INTO order_admin_operations(reference,request_hash) VALUES(${p.reference},${hash}) ON CONFLICT DO NOTHING RETURNING reference`.execute(
            tx,
          );
        if (!inserted.rows.length) {
          const old = await sql<{
            request_hash: string;
          }>`SELECT request_hash FROM order_admin_operations WHERE reference=${p.reference}`.execute(
            tx,
          );
          if (old.rows[0]?.request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
          return;
        }
        if (p.kind === 'REPAIR') {
          if (p.state === 'CANCELLED')
            await orders.cancel(p.orderId, { type: 'ADMIN', id: checkerId }, p.reason, { tx });
          else await orders.forceState(p.orderId, 'EXPIRED', p.reason, checkerId, tx);
        } else {
          let remaining = BigInt(p.amountPaise!);
          const flag = await sql<{
            enabled: boolean;
          }>`SELECT enabled FROM feature_flags WHERE key='wallet_enabled'`.execute(tx);
          const walletEnabled = flag.rows[0]?.enabled === true;
          for (const source of await refunds.refundableCapacity(p.orderId, tx)) {
            const take =
              BigInt(source.availablePaise) < remaining ? BigInt(source.availablePaise) : remaining;
            if (take <= 0n) continue;
            await refunds.commit({
              orderId: p.orderId,
              sourceType: source.sourceType,
              sourceId: source.sourceId,
              amountPaise: take.toString(),
              destination:
                source.sourceType === 'GATEWAY_CAPTURE'
                  ? 'GATEWAY'
                  : source.sourceType === 'COD_COLLECTION' && !walletEnabled
                    ? 'MANUAL_PAYOUT'
                    : 'WALLET',
              gatewayPaymentId:
                source.sourceType === 'GATEWAY_CAPTURE' ? source.sourceId : undefined,
              reason: 'ADMIN_REFUND',
              initiatedBy: checkerId,
              refundReference: `${p.reference}:${source.sourceType}:${source.sourceId}`,
              tx,
            });
            remaining -= take;
          }
          if (remaining !== 0n) throw new Error('REFUND_LIMIT_EXCEEDED');
          await sql`INSERT INTO order_adjustments(id,order_id,kind,amount_paise,reason,adjustment_reference,created_by)
        VALUES(${uuidV7()}::uuid,${p.orderId}::uuid,'CORRECTION',${p.amountPaise!}::bigint,${p.reason},${p.reference},${checkerId}::uuid)`.execute(
            tx,
          );
        }
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${checkerId}::uuid,
      'orders.approved_admin_action','order',${p.orderId},${JSON.stringify(p)}::jsonb)`.execute(tx);
      },
    };
    this.action = action;
    this.executor = factory.create({
      orderAdministration: action,
      orderRepair: { ...action, makerRole: 'SUPER_ADMIN' },
      supportRefund: { ...action, makerRole: 'SUPPORT_AGENT', checkerRole: 'ADMIN' },
      ticketAdminRefund: action,
    });
  }
  requestRefund(
    makerId: string,
    orderId: string,
    input: { amountPaise: string; reason: string },
    reference: string,
  ) {
    return this.request(makerId, {
      kind: 'REFUND',
      orderId,
      ...input,
      reference: `refund:${makerId}:${reference}`,
    });
  }
  async requestTicketAdminRefund(
    makerId: string,
    orderId: string,
    input: { amountPaise: string; reason: string },
    reference: string,
  ): Promise<string> {
    const p: Request = {
      kind: 'REFUND',
      orderId,
      ...input,
      reference: `ticket-admin-refund:${makerId}:${reference}`,
    };
    return this.idempotentApproval(makerId, 'ticketAdminRefund', p);
  }
  private async existingApproval(
    makerId: string,
    action: string,
    p: Request,
  ): Promise<string | null> {
    const role = action === 'supportRefund' ? 'SUPPORT_AGENT' : 'ADMIN';
    const actor =
      await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${makerId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role=${role}`.execute(
        this.db,
      );
    if (!actor.rows.length) throw new Error('FORBIDDEN');
    const row = await sql<{
      id: string;
      same: boolean;
    }>`SELECT id,payload=${JSON.stringify(p)}::jsonb AS same FROM maker_checker_requests WHERE maker_id=${makerId}::uuid AND action=${action} AND payload->>'reference'=${p.reference}`.execute(
      this.db,
    );
    if (!row.rows[0]) return null;
    if (!row.rows[0].same) throw new Error('IDEMPOTENCY_KEY_REUSED');
    return row.rows[0].id;
  }
  private async idempotentApproval(makerId: string, action: string, p: Request): Promise<string> {
    const prior = await this.existingApproval(makerId, action, p);
    if (prior) return prior;
    try {
      return await this.executor.request(makerId, action, p as unknown as Json);
    } catch (error) {
      const retry = await this.existingApproval(makerId, action, p);
      if (retry) return retry;
      throw error;
    }
  }
  async requestSupportRefund(
    makerId: string,
    orderId: string,
    input: { amountPaise: string; reason: string },
    reference: string,
  ) {
    const p: Request = {
      kind: 'REFUND',
      orderId,
      ...input,
      reference: `support-refund:${makerId}:${reference}`,
    };
    if (!valid(p as unknown as Json)) throw new Error('INVALID_INPUT');
    const prior = await this.existingApproval(makerId, 'supportRefund', p);
    if (prior) return prior;
    const direct = await transactionWithRetry(this.db, async (tx) => {
      const maker = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.id=${makerId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='SUPPORT_AGENT' FOR UPDATE OF u`.execute(
        tx,
      );
      if (!maker.rows.length) throw new Error('FORBIDDEN');
      const hash = hashRequest(JSON.stringify(p));
      const previous = await sql<{
        request_hash: string;
      }>`SELECT request_hash FROM support_direct_refunds WHERE reference=${p.reference}`.execute(
        tx,
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return true;
      }
      const per = BigInt(await this.config.get('supportDirectRefundLimitPaise', tx)),
        day = BigInt(await this.config.get('supportDailyRefundLimitPaise', tx));
      const amount = BigInt(input.amountPaise);
      if (per === 0n || day === 0n || amount > per) return false;
      const total = await sql<{
        used: string;
      }>`SELECT COALESCE(SUM(amount_paise),0)::text AS used FROM support_direct_refunds WHERE maker_id=${makerId}::uuid AND created_at >= (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`.execute(
        tx,
      );
      if (BigInt(total.rows[0]?.used ?? '0') + amount > day) return false;
      await sql`INSERT INTO support_direct_refunds(reference,maker_id,amount_paise,request_hash) VALUES(${p.reference},${makerId}::uuid,${input.amountPaise}::bigint,${hash})`.execute(
        tx,
      );
      await this.action.execute(tx, p as unknown as Json, uuidV7(), makerId);
      return true;
    });
    if (direct) return `direct:${p.reference}`;
    return this.idempotentApproval(makerId, 'supportRefund', p);
  }
  requestRepair(
    makerId: string,
    orderId: string,
    input: { state: 'CANCELLED' | 'EXPIRED'; reason: string },
    reference: string,
  ) {
    return this.request(makerId, {
      kind: 'REPAIR',
      orderId,
      ...input,
      reference: `repair:${makerId}:${reference}`,
    });
  }
  private request(makerId: string, p: Request) {
    return this.executor.request(
      makerId,
      p.kind === 'REPAIR' ? 'orderRepair' : 'orderAdministration',
      p as unknown as Json,
    );
  }
  approve(checkerId: string, requestId: string) {
    return this.executor.approve(checkerId, requestId);
  }
}
