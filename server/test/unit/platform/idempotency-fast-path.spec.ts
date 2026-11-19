import type { CompiledQuery } from 'kysely';
import { IdempotencyStore, hashRequest } from '../../../src/common/idempotency/idempotency.js';
import { fakeDatabase } from '../helpers/fake-db.js';

const SCOPE = {
  actor: 'actor',
  audience: 'customer',
  method: 'PUT',
  resource: '/v1/customer/cart/items/v',
  key: 'key-1',
};
const HASH = hashRequest('{}');

function store(route: (query: CompiledQuery) => { rows: unknown[] }) {
  const { db, queries, transaction } = fakeDatabase(route);
  return { store: new IdempotencyStore(db), queries, transaction };
}

test('fresh keys return from INSERT without opening the fenced transaction', async () => {
  const {
    store: idem,
    queries,
    transaction,
  } = store((query) =>
    query.sql.startsWith('INSERT INTO idempotency_keys')
      ? { rows: [{ operation_id: 'op-fresh' }] }
      : { rows: [] },
  );
  const claim = await idem.claim(SCOPE, HASH);
  expect(claim).toEqual({
    kind: 'claimed',
    owner: expect.objectContaining({ scope: SCOPE, operationId: 'op-fresh' }),
  });
  expect(queries).toHaveLength(1);
  expect(transaction).not.toHaveBeenCalled();
});

test('conflicts keep the fenced path with its post-lock time check', async () => {
  const { store: idem, queries } = store((query) => {
    if (query.sql.startsWith('INSERT INTO idempotency_keys')) return { rows: [] };
    if (query.sql.includes('AS live')) return { rows: [] };
    if (query.sql.includes('FOR UPDATE'))
      return {
        rows: [
          {
            request_hash: HASH,
            canonical_request_hash: null,
            operation_id: 'op-old',
            state: 'PROCESSING',
            owner_token: 'other',
            lease_until: new Date(Date.now() - 60_000),
            response_status: null,
            response_body: null,
          },
        ],
      };
    if (query.sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  });
  const claim = await idem.claim(SCOPE, HASH);
  expect(claim.kind).toBe('claimed');
  // Fast INSERT, live check, locked read, post-lock clock, lease steal.
  expect(queries).toHaveLength(5);
  expect(queries.some((query) => query.sql.includes('clock_timestamp() AS now'))).toBe(true);
});

test('completed keys still replay exactly through the fenced path', async () => {
  const body = { cart: { version: 3 } };
  const { store: idem } = store((query) => {
    if (query.sql.startsWith('INSERT INTO idempotency_keys')) return { rows: [] };
    if (query.sql.includes('AS live'))
      return {
        rows: [
          {
            request_hash: HASH,
            canonical_request_hash: null,
            operation_id: 'op-done',
            state: 'COMPLETED',
            live: false,
          },
        ],
      };
    if (query.sql.includes('FOR UPDATE'))
      return {
        rows: [
          {
            request_hash: HASH,
            canonical_request_hash: null,
            operation_id: 'op-done',
            state: 'COMPLETED',
            owner_token: null,
            lease_until: null,
            response_status: 200,
            response_body: body,
          },
        ],
      };
    if (query.sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  });
  await expect(idem.claim(SCOPE, HASH)).resolves.toEqual({
    kind: 'replay',
    operationId: 'op-done',
    status: 200,
    body,
  });
});

test('live claims still answer without waiting behind the owner transaction', async () => {
  const { store: idem, transaction } = store((query) => {
    if (query.sql.startsWith('INSERT INTO idempotency_keys')) return { rows: [] };
    if (query.sql.includes('AS live'))
      return {
        rows: [
          {
            request_hash: HASH,
            canonical_request_hash: null,
            operation_id: 'op-live',
            state: 'PROCESSING',
            live: true,
          },
        ],
      };
    return { rows: [] };
  });
  await expect(idem.claim(SCOPE, HASH)).resolves.toEqual({
    kind: 'in_progress',
    operationId: 'op-live',
  });
  expect(transaction).not.toHaveBeenCalled();
});
