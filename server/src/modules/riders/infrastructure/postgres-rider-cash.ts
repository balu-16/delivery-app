import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { moneyString, parseMoney } from '../../../common/money/money.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type {
  CashInHandView,
  CashPage,
  CodCollectInput,
  CodCollectResult,
  CodCollections,
  RiderCash,
} from '../contracts/riders.js';
import type { RiderSettings } from './settings.js';

interface LedgerRow {
  id: string;
  rider_id: string;
  delta_paise: string;
  reason: 'COD_COLLECTED' | 'COD_DEPOSIT' | 'ADJUSTMENT';
  ref_type: string;
  ref_id: string;
  balance_after: string;
  created_at: Date;
}

function mapEntry(row: LedgerRow) {
  return {
    id: row.id,
    deltaPaise: row.delta_paise,
    reason: row.reason,
    refType: row.ref_type,
    refId: row.ref_id,
    balanceAfter: row.balance_after,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Cash-in-hand ledger and COD collection records. The single expected-amount
 * read joins 007's frozen orders.amount_due column (P6 table, read-only);
 * the dispatch deliver flow re-checks through the P6 read port before
 * completing, so a mismatch can never reach an automatic DELIVERED.
 */
export class PostgresRiderCash implements RiderCash, CodCollections {
  constructor(
    private readonly db: Database,
    private readonly settings: RiderSettings,
  ) {}
  private run<T>(fn: (tx: TransactionContext) => Promise<T>, tx?: TransactionContext): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }

  private async held(tx: TransactionContext, riderId: string): Promise<bigint> {
    const rows = await sql<{
      balance_after: string;
    }>`SELECT balance_after FROM rider_cash_ledger WHERE rider_id=${riderId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`.execute(
      tx,
    );
    return rows.rows[0] ? parseMoney(rows.rows[0].balance_after) : 0n;
  }

  async cashInHand(riderId: string): Promise<CashInHandView> {
    return this.run(async (tx) => {
      const balance = await this.held(tx, riderId);
      let limitPaise: string | null;
      try {
        limitPaise = await this.settings.paise('cashInHandLimitPaise');
      } catch {
        limitPaise = null;
      }
      return { cashInHandPaise: moneyString(balance), limitPaise };
    });
  }

  async ledger(riderId: string, cursor?: string, limit?: number): Promise<CashPage> {
    const pageLimit = Math.min(Math.max(limit ?? 50, 1), 100);
    const before = decodeCashCursor(cursor);
    const rows = before
      ? await sql<LedgerRow>`SELECT id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after,created_at FROM rider_cash_ledger
          WHERE rider_id=${riderId}::uuid AND (created_at, id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)
          ORDER BY created_at DESC, id DESC LIMIT ${pageLimit}`.execute(this.db)
      : await sql<LedgerRow>`SELECT id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after,created_at FROM rider_cash_ledger
          WHERE rider_id=${riderId}::uuid ORDER BY created_at DESC, id DESC LIMIT ${pageLimit}`.execute(
          this.db,
        );
    const items = rows.rows.map(mapEntry);
    const last = rows.rows.at(-1);
    return {
      items,
      nextCursor:
        rows.rows.length === pageLimit && last
          ? encodeCashCursor(last.created_at.toISOString(), last.id)
          : null,
    };
  }

  async recordDeposit(input: {
    riderId: string;
    amountPaise: string;
    depositReference: string;
    storeId?: string;
    actorId: string;
  }): Promise<{ id: string; discrepancyPaise: string }> {
    const amount = parseMoney(input.amountPaise);
    if (amount <= 0n) throw new Error('INVALID_MONEY');
    if (!input.depositReference || input.depositReference.length > 150)
      throw new Error('INVALID_INPUT');
    return this.run(async (tx) => {
      const authorized = await sql<{
        ok: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=${input.actorId}::uuid AND u.status='ACTIVE' AND (EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role IN ('ADMIN','SUPER_ADMIN')) OR (${input.storeId ?? null}::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM store_staff s WHERE s.user_id=u.id AND s.store_id=${input.storeId ?? null}::uuid AND s.role='STORE_MANAGER')))) AS ok`.execute(
        tx,
      );
      if (!authorized.rows[0]?.ok) throw new Error('FORBIDDEN');
      await sql`INSERT INTO rider_status(rider_id) VALUES(${input.riderId}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`SELECT 1 FROM rider_status WHERE rider_id=${input.riderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const held = await this.held(tx, input.riderId);
      const applied = amount > held ? held : amount;
      const discrepancy = amount - applied;
      const now = await databaseTimeAfterLock(tx);
      const settlementId = uuidV7();
      const inserted = await sql<{
        id: string;
      }>`INSERT INTO cod_settlements(id,rider_id,store_id,amount_paise,deposit_reference,discrepancy_paise,recorded_by)
        VALUES(${settlementId}::uuid,${input.riderId}::uuid,${input.storeId ?? null}::uuid,${amount.toString()},${input.depositReference},${discrepancy.toString()},${input.actorId}::uuid)
        ON CONFLICT (deposit_reference) DO NOTHING RETURNING id`.execute(tx);
      if (!inserted.rows[0]) {
        const existing = await sql<{
          id: string;
          discrepancy_paise: string;
          rider_id: string;
          store_id: string | null;
          amount_paise: string;
          recorded_by: string | null;
        }>`SELECT id,discrepancy_paise::text AS discrepancy_paise,rider_id,store_id,amount_paise::text AS amount_paise,recorded_by FROM cod_settlements WHERE deposit_reference=${input.depositReference}`.execute(
          tx,
        );
        const prior = existing.rows[0];
        if (
          !prior ||
          prior.rider_id !== input.riderId ||
          prior.store_id !== (input.storeId ?? null) ||
          prior.amount_paise !== amount.toString() ||
          prior.recorded_by !== input.actorId
        )
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        return {
          id: existing.rows[0]!.id,
          discrepancyPaise: existing.rows[0]!.discrepancy_paise,
        };
      }
      if (applied > 0n) {
        const balance = held - applied;
        await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after)
          VALUES(${uuidV7()}::uuid,${input.riderId}::uuid,${(-applied).toString()},'COD_DEPOSIT','cod_settlement',${settlementId},${balance.toString()})`.execute(
          tx,
        );
      }
      if (discrepancy > 0n)
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${input.actorId}::uuid,'COD_DEPOSIT_DISCREPANCY','cod_settlement',${settlementId},${JSON.stringify(
          {
            riderId: input.riderId,
            depositedPaise: amount.toString(),
            heldPaise: held.toString(),
            discrepancyPaise: discrepancy.toString(),
          },
        )}::jsonb)`.execute(tx);
      const eventId = uuidV7();
      await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${eventId}::uuid,'riders.cash_deposited',1,'cod_settlement',${settlementId}::uuid,1::bigint,${input.riderId},${JSON.stringify(
        {
          riderId: input.riderId,
          settlementId,
          amountPaise: amount.toString(),
          discrepancyPaise: discrepancy.toString(),
          at: now.toISOString(),
        },
      )}::jsonb)`.execute(tx);
      await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,'notifications')`.execute(
        tx,
      );
      return { id: settlementId, discrepancyPaise: discrepancy.toString() };
    });
  }

  async collect(input: CodCollectInput, outer?: TransactionContext): Promise<CodCollectResult> {
    const amount = parseMoney(input.amountPaise);
    if (amount <= 0n) throw new Error('INVALID_MONEY');
    return this.run(async (tx) => {
      // Lock order before rider status (documented lock hierarchy).
      const order = await sql<{
        amount_due_paise: string;
      }>`SELECT COALESCE((SELECT expected_amount_paise FROM cod_collections WHERE order_id=orders.id),amount_due_paise)::text AS amount_due_paise
        FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(tx);
      if (!order.rows[0]) throw new Error('ORDER_NOT_FOUND');
      await sql`INSERT INTO rider_status(rider_id) VALUES(${input.riderId}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`SELECT 1 FROM rider_status WHERE rider_id=${input.riderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const now = await databaseTimeAfterLock(tx);
      const existing = await sql<{
        state: string;
        amount_paise: string;
        version: number;
      }>`SELECT state,amount_paise::text AS "amount_paise",version FROM cod_collections WHERE order_id=${input.orderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const held = await this.held(tx, input.riderId);
      const previous = existing.rows[0];
      if (previous && previous.state === 'COLLECTED') {
        if (previous.amount_paise === amount.toString())
          return {
            state: 'COLLECTED' as const,
            mismatch: order.rows[0]!.amount_due_paise !== amount.toString(),
            expectedPaise: order.rows[0]!.amount_due_paise,
          };
        // Correction: the ledger stays append-only; the delta is an ADJUSTMENT
        // row keyed by the cod_collections version it corrects.
        const balance = held + (amount - BigInt(previous.amount_paise));
        await sql`UPDATE cod_collections SET amount_paise=${amount.toString()},collected_at=${now.toISOString()}::timestamptz,collected_by=${input.riderId}::uuid,version=version+1 WHERE order_id=${input.orderId}::uuid`.execute(
          tx,
        );
        await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after)
          VALUES(${uuidV7()}::uuid,${input.riderId}::uuid,${(amount - BigInt(previous.amount_paise)).toString()},'ADJUSTMENT','cod_correction',${`${input.orderId}:${previous.version + 1}`},${balance.toString()})`.execute(
          tx,
        );
        return {
          state: 'COLLECTED' as const,
          mismatch: order.rows[0]!.amount_due_paise !== amount.toString(),
          expectedPaise: order.rows[0]!.amount_due_paise,
        };
      }
      const balance = held + amount;
      await sql`INSERT INTO cod_collections(id,order_id,amount_paise,state,collected_at,collected_by)
        VALUES(${uuidV7()}::uuid,${input.orderId}::uuid,${amount.toString()},'COLLECTED',${now.toISOString()}::timestamptz,${input.riderId}::uuid)
        ON CONFLICT (order_id) DO UPDATE SET state='COLLECTED',amount_paise=EXCLUDED.amount_paise,collected_at=EXCLUDED.collected_at,collected_by=EXCLUDED.collected_by,version=cod_collections.version+1`.execute(
        tx,
      );
      await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after)
        VALUES(${uuidV7()}::uuid,${input.riderId}::uuid,${amount.toString()},'COD_COLLECTED','cod_collection',${input.orderId},${balance.toString()})
        ON CONFLICT (rider_id,ref_type,ref_id,reason) DO NOTHING`.execute(tx);
      return {
        state: 'COLLECTED' as const,
        mismatch: order.rows[0]!.amount_due_paise !== amount.toString(),
        expectedPaise: order.rows[0]!.amount_due_paise,
      };
    }, outer);
  }
}

function encodeCashCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}
function decodeCashCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    if (typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}
