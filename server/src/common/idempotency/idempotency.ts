import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../ids/ids.js';
import {
  databaseTimeAfterLock,
  type Database,
  type Json,
  type TransactionContext,
} from '../../platform/database/database.js';

export interface IdempotencyScope {
  actor: string;
  audience: string;
  method: string;
  resource: string;
  key: string;
}
export interface IdempotencyOwner {
  scope: IdempotencyScope;
  token: string;
  operationId: string;
}
export type ClaimResult =
  | { kind: 'claimed'; owner: IdempotencyOwner }
  | { kind: 'in_progress'; operationId: string }
  | { kind: 'replay'; operationId: string; status: number; body: Json }
  | { kind: 'response_expired'; operationId: string }
  | { kind: 'key_reused' };
interface Row {
  request_hash: string;
  canonical_request_hash: string | null;
  operation_id: string;
  state: 'PROCESSING' | 'COMPLETED';
  owner_token: string | null;
  lease_until: Date | null;
  response_status: number | null;
  response_body: Json;
}

/** Hash already validated and canonically normalized request data; include path parameters. */
export function hashRequest(canonicalInput: string): string {
  return createHash('sha256').update(canonicalInput).digest('hex');
}

/** Canonical JSON retains array order while sorting object keys recursively. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function hashCanonical(value: unknown): string {
  return hashRequest(JSON.stringify(canonical(value)));
}

export class IdempotencyStore {
  constructor(private readonly db: Database) {}

  async claim(
    scope: IdempotencyScope,
    requestHash: string,
    leaseSeconds = 30,
    canonicalHash?: string,
  ): Promise<ClaimResult> {
    if (
      Object.values(scope).some((value) => !value || value.length > 512) ||
      !/^[a-f0-9]{64}$/.test(requestHash) ||
      (canonicalHash !== undefined && !/^[a-f0-9]{64}$/.test(canonicalHash)) ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 3600
    )
      throw new Error('INVALID_IDEMPOTENCY_INPUT');
    const token = uuidV7();
    const operationId = uuidV7();
    // An executing mutation holds the owner row until commit. Check a live
    // claim without a lock first so a concurrent retry receives 409 instead of
    // waiting behind the business transaction and exhausting its deadline.
    const current = await sql<{
      request_hash: string;
      canonical_request_hash: string | null;
      operation_id: string;
      state: string;
      live: boolean;
    }>`
      SELECT request_hash,canonical_request_hash,operation_id,state,lease_until>clock_timestamp() AS live
      FROM idempotency_keys WHERE actor=${scope.actor} AND audience=${scope.audience} AND method=${scope.method}
      AND resource=${scope.resource} AND key=${scope.key}`.execute(this.db);
    const running = current.rows[0];
    if (running?.state === 'PROCESSING' && running.live) {
      if (
        running.request_hash !== requestHash &&
        (!canonicalHash || running.canonical_request_hash !== canonicalHash)
      )
        return { kind: 'key_reused' };
      return { kind: 'in_progress', operationId: running.operation_id };
    }
    return this.db.transaction().execute(async (tx) => {
      const inserted = await sql<{ operation_id: string }>`INSERT INTO idempotency_keys
        (actor, audience, method, resource, key, request_hash, canonical_request_hash, operation_id, state, owner_token, lease_until)
        VALUES (${scope.actor}, ${scope.audience}, ${scope.method}, ${scope.resource}, ${scope.key}, ${requestHash}, ${canonicalHash ?? null}, ${operationId}::uuid, 'PROCESSING', ${token}::uuid, clock_timestamp() + ${leaseSeconds} * interval '1 second')
        ON CONFLICT DO NOTHING RETURNING operation_id`.execute(tx);
      const result =
        await sql<Row>`SELECT request_hash, canonical_request_hash, operation_id, state, owner_token, lease_until, response_status, response_body
        FROM idempotency_keys WHERE actor=${scope.actor} AND audience=${scope.audience} AND method=${scope.method} AND resource=${scope.resource} AND key=${scope.key} FOR UPDATE`.execute(
          tx,
        );
      const row = result.rows[0];
      if (!row) throw new Error('IDEMPOTENCY_ROW_MISSING');
      const now = await databaseTimeAfterLock(tx);
      if (
        row.request_hash !== requestHash &&
        (!canonicalHash || row.canonical_request_hash !== canonicalHash)
      )
        return { kind: 'key_reused' };
      if (!row.canonical_request_hash && canonicalHash && row.request_hash === requestHash)
        await sql`UPDATE idempotency_keys SET canonical_request_hash=${canonicalHash} WHERE actor=${scope.actor}
          AND audience=${scope.audience} AND method=${scope.method} AND resource=${scope.resource} AND key=${scope.key}`.execute(
          tx,
        );
      if (row.state === 'COMPLETED')
        return row.response_status === null
          ? { kind: 'response_expired', operationId: row.operation_id }
          : {
              kind: 'replay',
              operationId: row.operation_id,
              status: row.response_status,
              body: row.response_body,
            };
      if (inserted.rows.length > 0)
        return { kind: 'claimed', owner: { scope, token, operationId: row.operation_id } };
      if (row.lease_until && row.lease_until > now)
        return { kind: 'in_progress', operationId: row.operation_id };
      await sql`UPDATE idempotency_keys SET owner_token=${token}::uuid, lease_until=clock_timestamp() + ${leaseSeconds} * interval '1 second', updated_at=clock_timestamp()
        WHERE actor=${scope.actor} AND audience=${scope.audience} AND method=${scope.method} AND resource=${scope.resource} AND key=${scope.key}`.execute(
        tx,
      );
      return { kind: 'claimed', owner: { scope, token, operationId: row.operation_id } };
    });
  }

  /** Hold the owner row across DB mutations so another process cannot steal an expired lease. */
  async lockOwner(tx: TransactionContext, owner: IdempotencyOwner): Promise<void> {
    const s = owner.scope;
    const result =
      await sql<Row>`SELECT request_hash,canonical_request_hash,operation_id,state,owner_token,lease_until,response_status,response_body
      FROM idempotency_keys WHERE actor=${s.actor} AND audience=${s.audience} AND method=${s.method}
      AND resource=${s.resource} AND key=${s.key} FOR UPDATE`.execute(tx);
    const row = result.rows[0];
    const now = await databaseTimeAfterLock(tx);
    if (
      !row ||
      row.state !== 'PROCESSING' ||
      row.owner_token !== owner.token ||
      row.operation_id !== owner.operationId ||
      !row.lease_until ||
      row.lease_until <= now
    )
      throw new Error('IDEMPOTENCY_LEASE_LOST');
  }

  /** Caller already holds the row lock, so extending it is safe even after a long transaction. */
  async extendLocked(
    tx: TransactionContext,
    owner: IdempotencyOwner,
    leaseSeconds = 120,
  ): Promise<void> {
    const s = owner.scope;
    const updated =
      await sql`UPDATE idempotency_keys SET lease_until=clock_timestamp()+${leaseSeconds}*interval '1 second',updated_at=clock_timestamp()
      WHERE actor=${s.actor} AND audience=${s.audience} AND method=${s.method} AND resource=${s.resource} AND key=${s.key}
      AND state='PROCESSING' AND owner_token=${owner.token}::uuid AND operation_id=${owner.operationId}::uuid`.execute(
        tx,
      );
    if (!updated.numAffectedRows) throw new Error('IDEMPOTENCY_LEASE_LOST');
  }

  async renew(owner: IdempotencyOwner, leaseSeconds = 120): Promise<boolean> {
    const s = owner.scope;
    const updated =
      await sql`UPDATE idempotency_keys SET lease_until=clock_timestamp()+${leaseSeconds}*interval '1 second',updated_at=clock_timestamp()
      WHERE actor=${s.actor} AND audience=${s.audience} AND method=${s.method} AND resource=${s.resource} AND key=${s.key}
      AND state='PROCESSING' AND owner_token=${owner.token}::uuid AND operation_id=${owner.operationId}::uuid
      AND lease_until>clock_timestamp()`.execute(this.db);
    return Boolean(updated.numAffectedRows);
  }

  async withRenewal<T>(owner: IdempotencyOwner, work: () => Promise<T>): Promise<T> {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.renew(owner)
        .catch(() => false)
        .finally(() => {
          renewing = false;
        });
    }, 20000);
    timer.unref();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /** Work must contain only transactional DB mutations; lock prevents live-owner lease theft. */
  async execute<T extends Json>(
    owner: IdempotencyOwner,
    work: (tx: TransactionContext, operationId: string) => Promise<{ status: number; body: T }>,
    responseRetentionSeconds = 86400,
  ): Promise<{ status: number; body: T }> {
    if (!Number.isSafeInteger(responseRetentionSeconds) || responseRetentionSeconds < 1)
      throw new Error('INVALID_RESPONSE_RETENTION');
    const s = owner.scope;
    return this.db.transaction().execute(async (tx) => {
      const result =
        await sql<Row>`SELECT request_hash, canonical_request_hash, operation_id, state, owner_token, lease_until, response_status, response_body FROM idempotency_keys
        WHERE actor=${s.actor} AND audience=${s.audience} AND method=${s.method} AND resource=${s.resource} AND key=${s.key} FOR UPDATE`.execute(
          tx,
        );
      const row = result.rows[0];
      const now = await databaseTimeAfterLock(tx);
      if (
        !row ||
        row.state !== 'PROCESSING' ||
        row.owner_token !== owner.token ||
        row.operation_id !== owner.operationId ||
        !row.lease_until ||
        row.lease_until <= now
      )
        throw new Error('IDEMPOTENCY_LEASE_LOST');
      const response = await work(tx, row.operation_id);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
        throw new Error('INVALID_RESPONSE_STATUS');
      await sql`UPDATE idempotency_keys SET state='COMPLETED', owner_token=NULL, lease_until=NULL, response_status=${response.status}, response_body=${JSON.stringify(response.body)}::jsonb,
        response_expires_at=clock_timestamp() + ${responseRetentionSeconds} * interval '1 second', updated_at=clock_timestamp()
        WHERE actor=${s.actor} AND audience=${s.audience} AND method=${s.method} AND resource=${s.resource} AND key=${s.key}`.execute(
        tx,
      );
      return response;
    });
  }

  /** Keep the key, request hash and operation reference permanently; only discard cached response. */
  async pruneResponses(): Promise<void> {
    await sql`UPDATE idempotency_keys SET response_status=NULL, response_body=NULL, response_expires_at=NULL, updated_at=clock_timestamp()
      WHERE state='COMPLETED' AND response_expires_at <= clock_timestamp()`.execute(this.db);
  }
}
