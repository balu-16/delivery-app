import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { createApplication } from '../src/bootstrap.js';
import { readEnv } from '../src/config/env.schema.js';
import { PLATFORM_DATABASE, PLATFORM_REDIS } from '../src/platform/contracts/runtime.js';
import type { DatabaseHandle } from '../src/platform/database/database.js';

/** Isolate all database writes inside one rolled-back transaction on one connection.
 * Application transactions are savepoints, so this smoke does not test commit behavior. */
export async function runAwsOrderSmoke(
  tokens: { access: string; id: string },
  subject: string,
): Promise<void> {
  const env = readEnv({
    ...process.env,
    APP_ROLE: 'customer',
    DATABASE_POOL_MAX: '1',
    LOG_LEVEL: 'silent',
  });
  const app = await createApplication(env);
  const db = app.get<DatabaseHandle>(PLATFORM_DATABASE).db;
  const redis = app.get<Redis>(PLATFORM_REDIS);
  const cacheKeys = new Set<string>();
  const originalSet = redis.set.bind(redis);
  // Capture only newly-created cache keys with test-specific contents for cleanup.
  Object.defineProperty(redis, 'set', {
    configurable: true,
    value: async (...args: Parameters<Redis['set']>) => {
      const key = String(args[0]);
      if (!(await redis.exists(key))) cacheKeys.add(key);
      return (originalSet as (...values: unknown[]) => Promise<unknown>)(...args);
    },
  });
  const nonce = randomUUID();
  const ip = `2001:db8:${nonce.slice(0, 4)}:${nonce.slice(4, 8)}::1`;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  for (const route of ['auth', 'default', 'search']) {
    cacheKeys.add(`delivery:rate:customer:${route}:${hash(ip)}`);
    cacheKeys.add(`delivery:rate:actor:customer:${route}:${hash(`CUSTOMER:${subject}`)}`);
  }
  let rootOpen = false;
  let counter = 0;
  let failure: unknown;
  try {
    await sql`BEGIN`.execute(db);
    rootOpen = true;
    Object.defineProperty(db, 'isTransaction', { configurable: true, value: true });
    Object.defineProperty(db, 'transaction', {
      configurable: true,
      value: () => ({
        execute: async (work: (transaction: typeof db) => Promise<unknown>) => {
          const name = `aws_smoke_${++counter}`;
          await sql.raw(`SAVEPOINT ${name}`).execute(db);
          try {
            const result = await work(db);
            await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(db);
            return result;
          } catch (error) {
            await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(db);
            await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(db);
            throw error;
          }
        },
      }),
    });
    const txid = (await sql<{ id: string }>`SELECT txid_current()::text AS id`.execute(db)).rows[0]
      ?.id;
    const rows = await sql<{
      id: string;
    }>`SELECT i.variant_id::text AS id FROM store_inventory i JOIN catalog_variants v ON v.id=i.variant_id WHERE i.store_id='01800000-0000-7000-8000-000000000011'::uuid AND i.on_hand>0 AND v.sku LIKE 'LOCAL-%' ORDER BY v.sku LIMIT 1`.execute(
      db,
    );
    const variant = rows.rows[0]?.id;
    if (!variant) throw new Error('Seeded stock is not yet available');
    const server = app.getHttpAdapter().getInstance();
    async function request(
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      token: string,
      payload?: Record<string, unknown>,
    ) {
      const response = await server.inject({
        method,
        url,
        remoteAddress: ip,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        ...(payload === undefined ? {} : { payload }),
      });
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new Error(
          `${method} ${url} returned ${response.statusCode}: ${response.body.slice(0, 300)}`,
        );
      return response.json();
    }
    await request('POST', '/v1/customer/auth/bootstrap', tokens.id);
    await request('GET', '/v1/customer/me', tokens.access);
    const address = await request('POST', '/v1/customer/addresses', tokens.access, {
      line1: `Smoke ${nonce}`,
      pincode: '560001',
      contactName: 'Smoke test',
      contactPhone: '+919876543210',
      lat: 12.9701,
      lng: 77.5901,
    });
    const addressId = address.address?.id;
    if (!addressId) throw new Error('Address response missing id');
    await request('PUT', `/v1/customer/cart/items/${variant}`, tokens.access, {
      quantity: '1',
      version: 1,
      addressId,
    });
    const quote = await request('POST', '/v1/customer/checkout/quote', tokens.access, {
      addressId,
    });
    if (!quote.quote?.quoteId || !quote.intentId)
      throw new Error('Quote response missing identifiers');
    const order = await request('POST', '/v1/customer/checkout/place', tokens.access, {
      quoteId: quote.quote.quoteId,
      intentId: quote.intentId,
      method: 'GATEWAY',
    });
    if (!order.order?.orderId) throw new Error('Order response missing identifier');
    await request('GET', `/v1/customer/orders/${order.order.orderId}`, tokens.access);
    const finalTxid = (await sql<{ id: string }>`SELECT txid_current()::text AS id`.execute(db))
      .rows[0]?.id;
    if (!txid || txid !== finalTxid) throw new Error('Smoke transaction unexpectedly changed');
    console.log('AWS-backed HTTP bootstrap, address, cart, quote, placement and order read: OK');
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailure: unknown;
    try {
      if (rootOpen) {
        await sql`ROLLBACK`.execute(db);
        const remaining = await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM users WHERE cognito_sub=${subject}`.execute(db);
        if (remaining.rows[0]?.n !== '0')
          cleanupFailure = new Error('Smoke database identity remains after rollback');
      }
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      for (const key of cacheKeys) await redis.del(key);
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      await app.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure)
      failure = new Error('Smoke cleanup needs review', { cause: cleanupFailure });
    else console.log('Smoke database transaction rolled back and test cache keys removed');
  }
  if (failure) throw failure;
}
