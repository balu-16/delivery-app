import { sql } from 'kysely';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { PaymentGatewayPort } from '../contracts/gateway.js';
import { recordFinding } from './findings.js';

/**
 * Nightly reconciliation (plan 20.4, P6.6): reports orphan or mismatched
 * money movements as admin-visible findings. It NEVER moves money, never
 * "fixes" balances and never retries a financial effect - D25 keeps every
 * correction behind an explicit, audited admin decision. Findings dedupe on
 * (kind, reference) while open, so repeated nightly runs do not spam.
 */
export class NightlyReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly gateway: PaymentGatewayPort,
  ) {}
  async run(limit: number): Promise<number> {
    let findings = 0;
    findings += await this.checkCapturedWithoutFunding();
    findings += await this.checkUnknownRefunds();
    findings += await this.checkStalePendingOperations();
    findings += await this.checkWalletLedgerBalance();
    findings += await this.checkRefundAllocations();
    findings += await this.checkGatewayCaptures(limit);
    return findings;
  }
  /** Captured attempts whose order never got funded and has no refund commitment. */
  private async checkCapturedWithoutFunding(): Promise<number> {
    return transactionWithRetry(this.db, async (tx) => {
      const rows = await sql<{
        id: string;
        order_id: string | null;
        status: string;
      }>`SELECT a.id::text AS id,
          a.order_id::text AS order_id, o.status AS status
        FROM payment_attempts a LEFT JOIN orders o ON o.id = a.order_id
        WHERE a.kind='ORDER_PAYMENT' AND a.status='CAPTURED'
          AND (o.status IS NULL OR o.status IN ('PENDING_PAYMENT','EXPIRED','PAYMENT_FAILED'))
          AND NOT EXISTS (
            SELECT 1 FROM payment_refunds r WHERE r.order_id = a.order_id
              AND r.reason IN ('LATE_CAPTURE','DUPLICATE_CAPTURE'))
        LIMIT 200`.execute(tx);
      for (const row of rows.rows)
        await recordFinding(tx, {
          kind: 'CAPTURE_WITHOUT_FUNDING',
          severity: 'CRITICAL',
          aggregateType: 'payment_attempt',
          aggregateId: row.id,
          reference: `${row.id}:${row.order_id ?? 'no-order'}`,
          details: { orderStatus: row.status },
        });
      return rows.rows.length;
    });
  }
  /** UNKNOWN refunds are reserved capacity awaiting resolution. */
  private async checkUnknownRefunds(): Promise<number> {
    return transactionWithRetry(this.db, async (tx) => {
      const rows = await sql<{
        id: string;
        refund_reference: string;
      }>`SELECT id::text AS id, refund_reference
        FROM payment_refunds WHERE status='UNKNOWN' AND updated_at <= clock_timestamp() - interval '24 hours'
        LIMIT 200`.execute(tx);
      for (const row of rows.rows)
        await recordFinding(tx, {
          kind: 'REFUND_UNKNOWN_STALE',
          severity: 'WARN',
          aggregateType: 'payment_refund',
          aggregateId: row.id,
          reference: row.refund_reference,
          details: { reason: 'unknown refund older than 24h; capacity stays reserved' },
        });
      return rows.rows.length;
    });
  }
  /** Durable create/refund operations that never resolved. */
  private async checkStalePendingOperations(): Promise<number> {
    return transactionWithRetry(this.db, async (tx) => {
      const rows = await sql<{
        id: string;
        reference: string;
        kind: string;
      }>`SELECT id::text AS id, reference, kind
        FROM durable_operations WHERE state='pending' AND created_at <= clock_timestamp() - interval '24 hours'
        LIMIT 200`.execute(tx);
      for (const row of rows.rows)
        await recordFinding(tx, {
          kind: 'DURABLE_OPERATION_STALE',
          severity: 'WARN',
          aggregateType: 'durable_operation',
          aggregateId: row.id,
          reference: row.reference,
          details: { kind: row.kind },
        });
      return rows.rows.length;
    });
  }
  /** SYS-02: wallet ledger sums must equal the stored bucket balances. */
  private async checkWalletLedgerBalance(): Promise<number> {
    return transactionWithRetry(this.db, async (tx) => {
      const rows = await sql<{
        id: string;
        ledger_cash: string;
        ledger_promo: string;
        cash: string;
        promo: string;
      }>`SELECT a.id::text AS id,
          COALESCE(SUM(CASE WHEN l.bucket='cash' THEN l.delta_paise ELSE 0 END),0)::text AS ledger_cash,
          COALESCE(SUM(CASE WHEN l.bucket='promo' THEN l.delta_paise ELSE 0 END),0)::text AS ledger_promo,
          a.cash_balance_paise::text AS cash, a.promo_balance_paise::text AS promo
        FROM wallet_accounts a JOIN wallet_ledger l ON l.account_id = a.id
        GROUP BY a.id, a.cash_balance_paise, a.promo_balance_paise
        HAVING COALESCE(SUM(CASE WHEN l.bucket='cash' THEN l.delta_paise ELSE 0 END),0) <> a.cash_balance_paise
            OR COALESCE(SUM(CASE WHEN l.bucket='promo' THEN l.delta_paise ELSE 0 END),0) <> a.promo_balance_paise
        LIMIT 200`.execute(tx);
      for (const row of rows.rows)
        await recordFinding(tx, {
          kind: 'WALLET_LEDGER_MISMATCH',
          severity: 'CRITICAL',
          aggregateType: 'wallet_account',
          aggregateId: row.id,
          reference: `wallet:${row.id}`,
          details: {
            ledgerCash: row.ledger_cash,
            ledgerPromo: row.ledger_promo,
            balanceCash: row.cash,
            balancePromo: row.promo,
          },
        });
      return rows.rows.length;
    });
  }
  /** Refund commitments can never exceed the funded amount of a source. */
  private async checkRefundAllocations(): Promise<number> {
    return transactionWithRetry(this.db, async (tx) => {
      const rows = await sql<{
        source_type: string;
        source_id: string;
        funded: string;
        committed: string;
      }>`SELECT
          r.source_type, r.source_id,
          COALESCE(SUM(ra.amount_paise),0)::text AS committed
        FROM payment_refunds r JOIN refund_allocations ra ON ra.refund_id = r.id
        WHERE r.status IN ('PENDING','PROCESSED','UNKNOWN')
        GROUP BY r.source_type, r.source_id LIMIT 500`.execute(tx);
      let found = 0;
      for (const row of rows.rows) {
        const funded = await this.fundedFor(tx, row.source_type, row.source_id);
        if (BigInt(row.committed) > funded) {
          found += 1;
          await recordFinding(tx, {
            kind: 'REFUND_EXCEEDS_FUNDING',
            severity: 'CRITICAL',
            aggregateType: 'refund_source',
            aggregateId: `${row.source_type}:${row.source_id}`,
            reference: `${row.source_type}:${row.source_id}`,
            details: { funded: funded.toString(), committed: row.committed },
          });
        }
      }
      return found;
    });
  }
  /** Cross-checks each recent capture against the authoritative gateway state. */
  private async checkGatewayCaptures(limit: number): Promise<number> {
    const rows = await sql<{
      id: string;
      gateway_order_id: string;
    }>`SELECT id::text AS id, gateway_order_id
      FROM payment_attempts WHERE status='CAPTURED' AND gateway_order_id IS NOT NULL
        AND updated_at >= clock_timestamp() - interval '24 hours'
      ORDER BY updated_at DESC LIMIT ${limit}`.execute(this.db);
    let found = 0;
    for (const row of rows.rows) {
      const payments = await this.gateway.listOrderPayments(row.gateway_order_id).catch(() => null);
      if (!payments) continue;
      const captured = payments.filter((p) => p.status === 'CAPTURED');
      if (captured.length === 0 || captured.length > 1) {
        found += 1;
        await recordFinding(this.db, {
          kind: 'GATEWAY_CAPTURE_MISMATCH',
          severity: 'CRITICAL',
          aggregateType: 'payment_attempt',
          aggregateId: row.id,
          reference: `${row.id}:${row.gateway_order_id}`,
          details: { gatewayCapturedCount: captured.length },
        });
      }
    }
    return found;
  }
  private async fundedFor(
    tx: TransactionContext,
    sourceType: string,
    sourceId: string,
  ): Promise<bigint> {
    if (sourceType === 'GATEWAY_CAPTURE') {
      const r = await sql<{
        total: string | null;
      }>`SELECT COALESCE(SUM(amount_paise),0)::text AS total
        FROM payment_attempts WHERE gateway_payment_id=${sourceId} AND status='CAPTURED'`.execute(
        tx,
      );
      return BigInt(r.rows[0]!.total ?? '0');
    }
    if (sourceType === 'WALLET_DEBIT') {
      const r = await sql<{
        promo: string;
        cash: string;
      }>`SELECT promo_paise::text AS promo, cash_paise::text AS cash
        FROM wallet_funding_allocations WHERE wallet_spend_reference=${sourceId}`.execute(tx);
      const row = r.rows[0];
      return row ? BigInt(row.promo) + BigInt(row.cash) : 0n;
    }
    const r = await sql<{
      total: string | null;
    }>`SELECT COALESCE(SUM(amount_paise),0)::text AS total
      FROM cod_collections WHERE id=${sourceId}::uuid AND state='COLLECTED'`.execute(tx);
    return BigInt(r.rows[0]!.total ?? '0');
  }
}

export interface ReconciliationFindingView {
  id: string;
  kind: string;
  severity: string;
  aggregateType: string;
  aggregateId: string;
  reference: string;
  details: Record<string, unknown>;
  status: string;
  createdAt: string;
}

/** Admin review query (GET /v1/admin/payments/reconciliation). */
export async function listOpenFindings(
  db: Database,
  filter: { severity?: string; kind?: string },
  limit: number,
): Promise<ReconciliationFindingView[]> {
  const rows = await sql<{
    id: string;
    kind: string;
    severity: string;
    aggregate_type: string;
    aggregate_id: string;
    reference: string;
    details: Record<string, unknown>;
    status: string;
    created_at: Date;
  }>`SELECT id::text AS id, kind, severity, aggregate_type, aggregate_id::text AS aggregate_id, reference,
      details, status, created_at
    FROM reconciliation_findings
    WHERE status='OPEN'
      ${filter.severity ? sql`AND severity=${filter.severity}` : sql``}
      ${filter.kind ? sql`AND kind=${filter.kind}` : sql``}
    ORDER BY created_at DESC LIMIT ${limit}`.execute(db);
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    reference: row.reference,
    details: row.details,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  }));
}
