import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { OrderHolds } from '../contracts/hold.js';

/** Administrative hold serializes against picking and dispatch on the order row. */
export class OrderHoldService implements OrderHolds {
  constructor(private readonly db: Database) {}
  async get(orderId: string) {
    const rows = await sql<{
      on_hold: boolean;
      hold_reason: string | null;
      hold_actor_id: string | null;
      held_at: Date | null;
    }>`SELECT on_hold,hold_reason,hold_actor_id::text,held_at FROM orders WHERE id=${orderId}::uuid`.execute(
      this.db,
    );
    const row = rows.rows[0];
    if (!row) throw new Error('ORDER_NOT_FOUND');
    return {
      held: row.on_hold,
      reason: row.hold_reason,
      actorId: row.hold_actor_id,
      heldAt: row.held_at?.toISOString() ?? null,
    };
  }
  async set(orderId: string, adminId: string, held: boolean, reason: string): Promise<void> {
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 300) throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      const admin = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.id=${adminId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE'
        AND r.role IN ('SUPER_ADMIN') FOR SHARE OF u,r`.execute(tx);
      if (!admin.rows.length) throw new Error('FORBIDDEN');
      const order = await sql<{
        status: string;
        on_hold: boolean;
      }>`SELECT status,on_hold FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
      if (!order.rows[0]) throw new Error('ORDER_NOT_FOUND');
      if (!['CONFIRMED', 'PICKING', 'PACKED'].includes(order.rows[0].status))
        throw new Error('ILLEGAL_STATE_TRANSITION');
      const pickup =
        await sql`SELECT 1 FROM delivery_tasks WHERE order_id=${orderId}::uuid AND pickup_at IS NOT NULL LIMIT 1`.execute(
          tx,
        );
      if (pickup.rows.length) throw new Error('ILLEGAL_STATE_TRANSITION');
      if (order.rows[0].on_hold === held) return;
      await sql`UPDATE orders SET on_hold=${held},hold_reason=${held ? trimmed : null},hold_actor_id=${held ? adminId : null}::uuid,
        held_at=CASE WHEN ${held} THEN clock_timestamp() ELSE NULL END,version=version+1,updated_at=clock_timestamp() WHERE id=${orderId}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO order_status_history(id,order_id,previous_state,state,action,actor_type,actor_id,reason)
        VALUES(${uuidV7()}::uuid,${orderId}::uuid,${order.rows[0].status},${order.rows[0].status},${held ? 'ORDER_HELD' : 'ORDER_RESUMED'},'ADMIN',${adminId}::uuid,${trimmed})`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES(${uuidV7()}::uuid,${adminId}::uuid,${held ? 'ORDER_HELD' : 'ORDER_RESUMED'},'order',${orderId},${JSON.stringify({ reason: trimmed })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
