import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type {
  WalletBucket,
  WalletBalances,
  WalletLedgerEntry,
  WalletLedgerPage,
  WalletReason,
  WalletViews,
} from '../contracts/wallet.js';

const MAX_LIMIT = 100;

/** Opaque cursor over the keyset (created_at, id) descending. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || !/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
function entry(row: {
  id: string;
  bucket: WalletBucket;
  delta_paise: string;
  reason: WalletReason;
  ref_type: string;
  ref_id: string;
  balance_after: string;
  created_at: Date;
}): WalletLedgerEntry {
  return {
    id: row.id,
    bucket: row.bucket,
    deltaPaise: row.delta_paise,
    reason: row.reason,
    refType: row.ref_type,
    refId: row.ref_id,
    balanceAfter: row.balance_after,
    createdAt: row.created_at.toISOString(),
  };
}

/** Customer-visible wallet reads; balances come from the locked account row. */
export class PostgresWalletViews implements WalletViews {
  constructor(private readonly db: Database) {}
  async balances(userId: string): Promise<WalletBalances> {
    const rows = await sql<{ id: string; cash: string; promo: string; version: string }>`SELECT id,
      cash_balance_paise::text AS cash, promo_balance_paise::text AS promo, version::text AS version
      FROM wallet_accounts WHERE user_id=${userId}::uuid`.execute(this.db);
    const row = rows.rows[0];
    if (!row) return { userId, cashPaise: '0', promoPaise: '0', version: '0' };
    return { userId, cashPaise: row.cash, promoPaise: row.promo, version: row.version };
  }
  async ledger(userId: string, limit: number, cursor?: string): Promise<WalletLedgerPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      throw new Error('INVALID_PAGE');
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
      bucket: WalletBucket;
      delta_paise: string;
      reason: WalletReason;
      ref_type: string;
      ref_id: string;
      balance_after: string;
      created_at: Date;
    }>`SELECT l.id,l.bucket,l.delta_paise::text AS delta_paise,l.reason,l.ref_type,l.ref_id,l.balance_after::text AS balance_after,l.created_at
      FROM wallet_ledger l JOIN wallet_accounts a ON a.id=l.account_id
      WHERE a.user_id=${userId}::uuid
        ${after ? sql`AND (l.created_at,l.id) < (${after.createdAt}::timestamptz,${after.id}::uuid)` : sql``}
      ORDER BY l.created_at DESC,l.id DESC LIMIT ${limit}`.execute(this.db);
    return this.page(rows.rows, limit);
  }
  async adminLedger(
    filter: { userId?: string; bucket?: WalletBucket; reason?: WalletReason },
    limit: number,
    cursor?: string,
  ): Promise<WalletLedgerPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      throw new Error('INVALID_PAGE');
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
      bucket: WalletBucket;
      delta_paise: string;
      reason: WalletReason;
      ref_type: string;
      ref_id: string;
      balance_after: string;
      created_at: Date;
    }>`SELECT l.id,l.bucket,l.delta_paise::text AS delta_paise,l.reason,l.ref_type,l.ref_id,l.balance_after::text AS balance_after,l.created_at
      FROM wallet_ledger l
      ${filter.userId ? sql`JOIN wallet_accounts a ON a.id=l.account_id AND a.user_id=${filter.userId}::uuid` : sql``}
      WHERE TRUE
        ${filter.bucket ? sql`AND l.bucket=${filter.bucket}` : sql``}
        ${filter.reason ? sql`AND l.reason=${filter.reason}` : sql``}
        ${after ? sql`AND (l.created_at,l.id) < (${after.createdAt}::timestamptz,${after.id}::uuid)` : sql``}
      ORDER BY l.created_at DESC,l.id DESC LIMIT ${limit}`.execute(this.db);
    return this.page(rows.rows, limit);
  }
  private page(rows: Array<Parameters<typeof entry>[0]>, limit: number): WalletLedgerPage {
    const items = rows.map(entry);
    const last = rows[rows.length - 1];
    return {
      items,
      nextCursor: rows.length === limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }
}
