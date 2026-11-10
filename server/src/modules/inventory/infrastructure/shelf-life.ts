import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { InventoryShelfLife, ShelfLifeInput } from '../contracts/shelf-life.js';
import { quantity } from '../domain/quantity.js';
import { operation } from './stock-primitives.js';
import { stockCursor, stockCursorId } from './paging.js';
export class PostgresShelfLife implements InventoryShelfLife {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}
  async set(actor: string, input: ShelfLifeInput): Promise<void> {
    quantity(input.expectedVersion, true);
    if (
      !Number.isSafeInteger(input.minSeconds) ||
      input.minSeconds < 0 ||
      input.minSeconds > 31536000 ||
      !input.reason.trim() ||
      input.reason.length > 500 ||
      !input.reference ||
      input.reference.length > 150
    )
      throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      if (!(await this.identity.hasRole(actor, ['ADMIN', 'SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      const reference = `shelf-life:${actor}:${input.reference}`;
      if (!(await operation(tx, reference, 'SHELF_LIFE', { actor, ...input }))) return;
      const category =
        await sql`SELECT id FROM catalog_categories WHERE id=${input.categoryId}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
          tx,
        );
      if (!category.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      const current = await sql<{
        version: string;
      }>`SELECT version::text FROM inventory_category_shelf_life WHERE category_id=${input.categoryId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if ((current.rows[0]?.version ?? '0') !== input.expectedVersion)
        throw new Error('CONCURRENT_MODIFICATION');
      await sql`INSERT INTO inventory_category_shelf_life(category_id,min_seconds,version) VALUES(${input.categoryId}::uuid,${input.minSeconds},1) ON CONFLICT(category_id) DO UPDATE SET min_seconds=EXCLUDED.min_seconds,version=inventory_category_shelf_life.version+1`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_SHELF_LIFE_CHANGED','category',${input.categoryId},${JSON.stringify({ minSeconds: input.minSeconds, reason: input.reason, reference })}::jsonb)`.execute(
        tx,
      );
    });
  }
  async list(actor: string, cursor?: string, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const scope = ['shelf-life'];
    const after = stockCursorId(cursor, scope);
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actor, ['ADMIN', 'SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      const rows = await sql<{
        categoryId: string;
        minSeconds: number;
        version: string;
      }>`SELECT category_id AS "categoryId",min_seconds AS "minSeconds",version::text FROM inventory_category_shelf_life WHERE (${after}::uuid IS NULL OR category_id>${after}::uuid) ORDER BY category_id LIMIT ${limit + 1}`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_SHELF_LIFE_READ','inventory_policy','all')`.execute(
        tx,
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor:
          rows.rows.length > limit ? stockCursor(rows.rows[limit - 1]!.categoryId, scope) : null,
      };
    });
  }
}
