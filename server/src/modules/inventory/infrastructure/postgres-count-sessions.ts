import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { InventoryAdjustments } from '../contracts/adjustments.js';
import type {
  CountSessionCreateInput,
  CountSessionLineInput,
  CountSessionLineView,
  CountSessionPage,
  CountSessionUpdateInput,
  CountSessionView,
  InventoryCountSessions,
} from '../contracts/count-sessions.js';
import { stockCursor, stockCursorId } from './paging.js';

const MAX_SNAPSHOT_LINES = 1000;
const COUNT_REFERENCE = /^(0|[1-9][0-9]{0,18})$/;

interface SessionRow {
  id: string;
  storeId: string;
  status: CountSessionView['status'];
  note: string | null;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

interface SessionLineRow extends Omit<CountSessionLineView, 'expiresAt'> {
  expiresAt: Date | null;
}

async function assertStoreRole(
  identity: IdentityAccess,
  actorId: string,
  storeId: string,
  tx?: TransactionContext,
): Promise<void> {
  if (!(await identity.hasStoreRole(actorId, storeId, ['STORE_MANAGER'], tx)))
    throw new Error('RESOURCE_NOT_FOUND');
}

function validCount(value: string | null | undefined): boolean {
  return value === null || value === undefined || COUNT_REFERENCE.test(value);
}

function validNote(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.length <= 500;
}

/** Persistent multi-line count sessions over the inventory batch ledger. */
export class PostgresCountSessions implements InventoryCountSessions {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly adjustments: InventoryAdjustments,
  ) {}

  private size(limit?: number): number {
    const value = limit ?? 20;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('INVALID_INPUT');
    return value;
  }

  private async loadSession(
    tx: TransactionContext,
    sessionId: string,
    lock = false,
  ): Promise<SessionRow | null> {
    const rows = await sql<SessionRow>`SELECT id,store_id AS "storeId",status,note,version::text,
      created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
      FROM inventory_count_sessions WHERE id=${sessionId}::uuid
      ${lock ? sql`FOR UPDATE` : sql``}`.execute(tx);
    return rows.rows[0] ?? null;
  }

  private async loadLines(
    tx: Database | TransactionContext,
    sessionIds: readonly string[],
  ): Promise<Array<SessionLineRow & { sessionId: string }>> {
    if (!sessionIds.length) return [];
    const rows = await sql<
      SessionLineRow & { sessionId: string }
    >`SELECT l.session_id AS "sessionId",
      l.line_no AS "lineNo",l.variant_id AS "variantId",p.name AS "variantName",v.sku,
      l.batch_id AS "batchId",b.batch_code AS "batchCode",b.expires_at AS "expiresAt",
      l.expected_qty::text AS "expectedQty",l.counted_qty::text AS "countedQty",l.reason,
      l.outcome,l.outcome_detail AS "outcomeDetail"
      FROM inventory_count_session_lines l
      JOIN catalog_variants v ON v.id=l.variant_id
      JOIN catalog_products p ON p.id=v.product_id
      JOIN inventory_batches b ON b.id=l.batch_id
      WHERE l.session_id=ANY(${sessionIds.slice()}::uuid[])
      ORDER BY l.session_id,l.line_no`.execute(tx);
    return rows.rows;
  }

  private lineView(line: SessionLineRow): CountSessionLineView {
    return {
      lineNo: line.lineNo,
      variantId: line.variantId,
      variantName: line.variantName,
      sku: line.sku,
      batchId: line.batchId,
      batchCode: line.batchCode,
      expiresAt: line.expiresAt?.toISOString() ?? null,
      expectedQty: line.expectedQty,
      countedQty: line.countedQty,
      reason: line.reason,
      outcome: line.outcome,
      outcomeDetail: line.outcomeDetail,
    };
  }

  private async view(tx: TransactionContext, sessionId: string): Promise<CountSessionView> {
    const session = await this.loadSession(tx, sessionId);
    if (!session) throw new Error('RESOURCE_NOT_FOUND');
    const lines = await this.loadLines(tx, [sessionId]);
    return {
      id: session.id,
      storeId: session.storeId,
      status: session.status,
      note: session.note,
      version: session.version,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      completedAt: session.completedAt?.toISOString() ?? null,
      lines: lines.map((line) => this.lineView(line)),
    };
  }

  private validateLines(lines: readonly CountSessionLineInput[] | undefined): void {
    if (!lines) return;
    if (lines.length > MAX_SNAPSHOT_LINES) throw new Error('INVALID_INPUT');
    const seen = new Set<string>();
    for (const line of lines) {
      if (!line.batchId || seen.has(line.batchId)) throw new Error('INVALID_INPUT');
      if (!validCount(line.counted) || !validNote(line.reason)) throw new Error('INVALID_INPUT');
      seen.add(line.batchId);
    }
  }

  async create(actorId: string, input: CountSessionCreateInput): Promise<CountSessionView> {
    if (!validNote(input.note)) throw new Error('INVALID_INPUT');
    this.validateLines(input.lines);
    return transactionWithRetry(this.db, async (tx) => {
      await assertStoreRole(this.identity, actorId, input.storeId, tx);
      const sessionId = uuidV7();
      await sql`INSERT INTO inventory_count_sessions(id,store_id,created_by,note)
        VALUES(${sessionId}::uuid,${input.storeId}::uuid,${actorId}::uuid,${input.note ?? null})`.execute(
        tx,
      );
      if (input.lines?.length) {
        const batches = await sql<{
          id: string;
          variantId: string;
          onHand: string;
        }>`SELECT id,variant_id AS "variantId",on_hand::text AS "onHand" FROM inventory_batches
          WHERE store_id=${input.storeId}::uuid AND id=ANY(${input.lines.map((line) => line.batchId)}::uuid[])`.execute(
          tx,
        );
        const byId = new Map(batches.rows.map((batch) => [batch.id, batch]));
        if (byId.size !== input.lines.length) throw new Error('RESOURCE_NOT_FOUND');
        for (const [index, line] of input.lines.entries()) {
          const batch = byId.get(line.batchId)!;
          await sql`INSERT INTO inventory_count_session_lines(session_id,line_no,variant_id,batch_id,expected_qty,counted_qty,reason)
            VALUES(${sessionId}::uuid,${index + 1},${batch.variantId}::uuid,${batch.id}::uuid,${batch.onHand}::bigint,${line.counted ?? null}::bigint,${line.reason ?? null})`.execute(
            tx,
          );
        }
      } else {
        const batches = await sql<{
          id: string;
          variantId: string;
          onHand: string;
        }>`SELECT b.id,b.variant_id AS "variantId",b.on_hand::text AS "onHand"
          FROM inventory_batches b
          JOIN catalog_variants v ON v.id=b.variant_id
          JOIN catalog_products p ON p.id=v.product_id
          WHERE b.store_id=${input.storeId}::uuid AND b.state='ACTIVE' AND b.on_hand > 0
          ORDER BY p.name,v.name,b.batch_code,b.id LIMIT ${MAX_SNAPSHOT_LINES}`.execute(tx);
        for (const [index, batch] of batches.rows.entries()) {
          await sql`INSERT INTO inventory_count_session_lines(session_id,line_no,variant_id,batch_id,expected_qty)
            VALUES(${sessionId}::uuid,${index + 1},${batch.variantId}::uuid,${batch.id}::uuid,${batch.onHand}::bigint)`.execute(
            tx,
          );
        }
      }
      return this.view(tx, sessionId);
    });
  }

  async get(actorId: string, sessionId: string): Promise<CountSessionView> {
    return transactionWithRetry(this.db, async (tx) => {
      const session = await this.loadSession(tx, sessionId);
      if (!session) throw new Error('RESOURCE_NOT_FOUND');
      await assertStoreRole(this.identity, actorId, session.storeId, tx);
      return this.view(tx, sessionId);
    });
  }

  async list(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<CountSessionPage> {
    await assertStoreRole(this.identity, actorId, storeId);
    const size = this.size(limit);
    const scope = ['store-count-sessions', storeId];
    const after = stockCursorId(cursor, scope);
    const rows = await sql<SessionRow>`SELECT id,store_id AS "storeId",status,note,version::text,
      created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
      FROM inventory_count_sessions
      WHERE store_id=${storeId}::uuid AND (${after}::uuid IS NULL OR id<${after}::uuid)
      ORDER BY id DESC LIMIT ${size + 1}`.execute(this.db);
    const page = rows.rows.slice(0, size);
    const lines = await this.loadLines(
      this.db,
      page.map((row) => row.id),
    );
    const bySession = new Map<string, Array<SessionLineRow & { sessionId: string }>>();
    for (const line of lines) {
      const list = bySession.get(line.sessionId) ?? [];
      list.push(line);
      bySession.set(line.sessionId, list);
    }
    const items = page.map((session) => ({
      id: session.id,
      storeId: session.storeId,
      status: session.status,
      note: session.note,
      version: session.version,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      completedAt: session.completedAt?.toISOString() ?? null,
      lines: (bySession.get(session.id) ?? []).map((line) => this.lineView(line)),
    }));
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.rows.length > size && last ? stockCursor(last.id, scope) : null,
    };
  }

  async update(
    actorId: string,
    sessionId: string,
    input: CountSessionUpdateInput,
  ): Promise<CountSessionView> {
    if (!validNote(input.note)) throw new Error('INVALID_INPUT');
    this.validateLines(input.lines);
    return transactionWithRetry(this.db, async (tx) => {
      const session = await this.loadSession(tx, sessionId, true);
      if (!session) throw new Error('RESOURCE_NOT_FOUND');
      await assertStoreRole(this.identity, actorId, session.storeId, tx);
      if (session.status !== 'OPEN') throw new Error('SESSION_CLOSED');
      if (input.expectedVersion && input.expectedVersion !== session.version)
        throw new Error('CONCURRENT_MODIFICATION');
      if (input.note !== undefined)
        await sql`UPDATE inventory_count_sessions SET note=${input.note ?? null} WHERE id=${sessionId}::uuid`.execute(
          tx,
        );
      for (const line of input.lines ?? []) {
        const updated = await sql`UPDATE inventory_count_session_lines
          SET counted_qty=${line.counted ?? null}::bigint,reason=${line.reason ?? null},updated_at=clock_timestamp()
          WHERE session_id=${sessionId}::uuid AND batch_id=${line.batchId}::uuid`.execute(tx);
        if (!updated.numAffectedRows) throw new Error('RESOURCE_NOT_FOUND');
      }
      if (input.note !== undefined || input.lines?.length)
        await sql`UPDATE inventory_count_sessions SET version=version+1,updated_at=clock_timestamp() WHERE id=${sessionId}::uuid`.execute(
          tx,
        );
      return this.view(tx, sessionId);
    });
  }

  async complete(actorId: string, sessionId: string, reference: string): Promise<CountSessionView> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    const { storeId, lines } = await transactionWithRetry(this.db, async (tx) => {
      const session = await this.loadSession(tx, sessionId, true);
      if (!session) throw new Error('RESOURCE_NOT_FOUND');
      await assertStoreRole(this.identity, actorId, session.storeId, tx);
      if (session.status !== 'OPEN') throw new Error('SESSION_CLOSED');
      const rows = await this.loadLines(tx, [sessionId]);
      await sql`UPDATE inventory_count_sessions SET status='COMPLETED',version=version+1,
        completed_at=clock_timestamp(),completed_by=${actorId}::uuid,updated_at=clock_timestamp()
        WHERE id=${sessionId}::uuid`.execute(tx);
      return { storeId: session.storeId, lines: rows };
    });

    for (const line of lines) {
      if (line.countedQty === null) {
        await sql`UPDATE inventory_count_session_lines SET outcome='FAILED',outcome_detail='NOT_COUNTED',updated_at=clock_timestamp()
          WHERE session_id=${sessionId}::uuid AND line_no=${line.lineNo}`.execute(this.db);
        continue;
      }
      try {
        const current = await sql<{
          version: string;
        }>`SELECT version::text FROM store_inventory WHERE store_id=${storeId}::uuid AND variant_id=${line.variantId}::uuid`.execute(
          this.db,
        );
        if (!current.rows[0]) throw new Error('VARIANT_NOT_STOCKED');
        const reason = line.reason?.trim() || `Stock count ${sessionId.slice(0, 8)}`;
        const result = await this.adjustments.count(actorId, {
          storeId,
          variantId: line.variantId,
          batchId: line.batchId,
          counted: line.countedQty,
          expectedVersion: current.rows[0].version,
          reason,
          reference: `count-session:${sessionId}:${line.lineNo}`,
        });
        await sql`UPDATE inventory_count_session_lines SET
          outcome=${result.approvalId ? 'PENDING_APPROVAL' : 'APPLIED'},
          outcome_detail=${result.approvalId ?? null},updated_at=clock_timestamp()
          WHERE session_id=${sessionId}::uuid AND line_no=${line.lineNo}`.execute(this.db);
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 500) : 'COUNT_FAILED';
        await sql`UPDATE inventory_count_session_lines SET outcome='FAILED',outcome_detail=${detail},updated_at=clock_timestamp()
          WHERE session_id=${sessionId}::uuid AND line_no=${line.lineNo}`.execute(this.db);
      }
    }
    return transactionWithRetry(this.db, (tx) => this.view(tx, sessionId));
  }

  async cancel(actorId: string, sessionId: string): Promise<CountSessionView> {
    return transactionWithRetry(this.db, async (tx) => {
      const session = await this.loadSession(tx, sessionId, true);
      if (!session) throw new Error('RESOURCE_NOT_FOUND');
      await assertStoreRole(this.identity, actorId, session.storeId, tx);
      if (session.status === 'COMPLETED') throw new Error('SESSION_CLOSED');
      if (session.status === 'OPEN')
        await sql`UPDATE inventory_count_sessions SET status='CANCELLED',version=version+1,
          completed_at=clock_timestamp(),completed_by=${actorId}::uuid,updated_at=clock_timestamp()
          WHERE id=${sessionId}::uuid`.execute(tx);
      return this.view(tx, sessionId);
    });
  }
}
