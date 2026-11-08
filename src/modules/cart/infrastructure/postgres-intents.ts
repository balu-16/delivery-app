import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
} from '../../../platform/database/database.js';
import type { CartIntents } from '../contracts/intent.js';
/**
 * D15 placement reference: one intent per (cart, version). A consumed intent can
 * never be consumed again — even under a different idempotency key — so a second
 * purchase requires a new cart version and a new intent.
 */
export class PostgresCartIntents implements CartIntents {
  constructor(private readonly db: Database) {}
  async issue(
    cartId: string,
    cartVersion: number,
    quoteId: string,
  ): Promise<{ intentId: string; expiresAt: string }> {
    if (!Number.isSafeInteger(cartVersion) || cartVersion < 1) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      await sql`SELECT id FROM carts WHERE id=${cartId}::uuid AND version=${cartVersion}::bigint FOR UPDATE`.execute(
        tx,
      );
      const quote = await sql<{ expires_at: Date }>`SELECT expires_at FROM quote_snapshots
        WHERE id=${quoteId}::uuid AND cart_id=${cartId}::uuid AND cart_version=${cartVersion}::bigint
          AND status='ACTIVE' AND expires_at>clock_timestamp()`.execute(tx);
      const expiresAt = quote.rows[0]?.expires_at;
      if (!expiresAt) throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO checkout_intents(id,cart_id,cart_version,quote_id,state,expires_at)
        VALUES(${uuidV7()}::uuid,${cartId}::uuid,${cartVersion}::bigint,${quoteId}::uuid,'ISSUED',${expiresAt})
        ON CONFLICT (cart_id,cart_version) DO UPDATE SET quote_id=EXCLUDED.quote_id,expires_at=EXCLUDED.expires_at
          WHERE checkout_intents.state='ISSUED'`.execute(tx);
      const row = await sql<{
        id: string;
        expires_at: Date;
        state: string;
      }>`SELECT id::text AS id,expires_at,state FROM checkout_intents
        WHERE cart_id=${cartId}::uuid AND cart_version=${cartVersion}::bigint`.execute(tx);
      if (row.rows[0]?.state !== 'ISSUED') throw new Error('CART_INTENT_CONSUMED');
      return {
        intentId: row.rows[0]!.id,
        expiresAt: new Date(row.rows[0]!.expires_at).toISOString(),
      };
    });
  }
  async consume(
    intentId: string,
    expected: { cartId: string; cartVersion: number; quoteId: string },
    tx: TransactionContext,
  ): Promise<void> {
    const result = await sql<{
      id: string;
      cart_id: string;
      cart_version: string;
      quote_id: string;
      state: string;
      expires_at: Date;
    }>`SELECT id::text AS id,cart_id::text AS cart_id,cart_version::text AS cart_version,quote_id::text AS quote_id,state,expires_at
      FROM checkout_intents WHERE id=${intentId}::uuid FOR UPDATE`.execute(tx);
    const row = result.rows[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    if (
      row.state !== 'ISSUED' ||
      row.cart_id !== expected.cartId ||
      BigInt(row.cart_version) !== BigInt(expected.cartVersion) ||
      row.quote_id !== expected.quoteId
    )
      throw new Error('CART_INTENT_CONSUMED');
    const now = await databaseTimeAfterLock(tx);
    if (new Date(row.expires_at) <= now) throw new Error('QUOTE_EXPIRED');
    await sql`UPDATE checkout_intents SET state='CONSUMED',consumed_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
      tx,
    );
  }
}
