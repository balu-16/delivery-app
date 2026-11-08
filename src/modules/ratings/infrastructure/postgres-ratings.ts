import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { lockActiveAccount } from '../../identity/contracts/account-lock.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { Ratings, RatingTarget } from '../contracts/ratings.js';
function text(input?: string): string | null {
  if (input === undefined) return null;
  const value = input.trim();
  if (value.length > 1000) throw new Error('INVALID_INPUT');
  return value
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function valid(stars: number): void {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('INVALID_INPUT');
}
export class PostgresRatings implements Ratings {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}
  private async low(
    tx: TransactionContext,
    id: string,
    owner: string,
    order: string,
    stars: number,
  ): Promise<void> {
    const threshold = await this.config.get('lowRatingThreshold', tx);
    if (stars > threshold) return;
    const first = await this.config.get('supportFirstResponseSlaHours', tx),
      resolution = await this.config.get('supportResolutionSlaHours', tx);
    await sql`INSERT INTO support_tickets(id,owner_id,order_id,category,status,incident_key,first_response_due_at,resolution_due_at) VALUES(${uuidV7()}::uuid,${owner}::uuid,${order}::uuid,'LOW_RATING','OPEN',${`rating:${id}`},clock_timestamp()+${first}*interval '1 hour',clock_timestamp()+${resolution}*interval '1 hour') ON CONFLICT (incident_key) DO NOTHING`.execute(
      tx,
    );
  }
  async create(
    userId: string,
    orderId: string,
    input: { targetType: RatingTarget; targetId: string; stars: number; comment?: string },
  ): Promise<string> {
    valid(input.stars);
    const comment = text(input.comment);
    if (!['ORDER', 'RIDER', 'PRODUCT'].includes(input.targetType)) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      await lockActiveAccount(userId, tx);
      const order = await sql<{
        status: string;
        delivered_at: Date | null;
      }>`SELECT status,delivered_at FROM orders WHERE id=${orderId}::uuid AND user_id=${userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!order.rows[0] || order.rows[0].status !== 'DELIVERED' || !order.rows[0].delivered_at)
        throw new Error('RATING_NOT_ALLOWED');
      const now = await databaseTimeAfterLock(tx),
        window = await this.config.get('ratingWindowHours', tx),
        edit = await this.config.get('ratingEditHours', tx);
      const deadline = order.rows[0].delivered_at.getTime() + window * 3600000;
      if (now.getTime() > deadline) throw new Error('RATING_WINDOW_EXPIRED');
      if (input.targetType === 'ORDER' && input.targetId !== orderId)
        throw new Error('RATING_TARGET_INVALID');
      if (input.targetType === 'PRODUCT') {
        const item =
          await sql`SELECT id FROM order_items WHERE order_id=${orderId}::uuid AND variant_id=${input.targetId}::uuid AND fulfilled_qty>0`.execute(
            tx,
          );
        if (!item.rows.length) throw new Error('RATING_TARGET_INVALID');
      }
      if (input.targetType === 'RIDER') {
        const rider =
          await sql`SELECT id FROM rider_earnings WHERE order_id=${orderId}::uuid AND rider_id=${input.targetId}::uuid`.execute(
            tx,
          );
        if (!rider.rows.length) throw new Error('RATING_TARGET_INVALID');
      }
      const id = uuidV7();
      const inserted = await sql<{
        id: string;
      }>`INSERT INTO ratings(id,order_id,rater_id,target_type,target_id,stars,comment,edit_until) VALUES(${id}::uuid,${orderId}::uuid,${userId}::uuid,${input.targetType},${input.targetId}::uuid,${input.stars},${comment},${new Date(Math.min(deadline, now.getTime() + edit * 3600000)).toISOString()}::timestamptz) ON CONFLICT(order_id,rater_id,target_type,target_id) DO NOTHING RETURNING id`.execute(
        tx,
      );
      if (!inserted.rows.length) throw new Error('RATING_EXISTS');
      await this.low(tx, id, userId, orderId, input.stars);
      return id;
    });
  }
  async edit(
    userId: string,
    orderId: string,
    ratingId: string,
    input: { stars: number; comment?: string },
  ): Promise<void> {
    valid(input.stars);
    const comment = text(input.comment);
    await transactionWithRetry(this.db, async (tx) => {
      await lockActiveAccount(userId, tx);
      const row = await sql<{
        edit_until: Date;
      }>`SELECT edit_until FROM ratings WHERE id=${ratingId}::uuid AND order_id=${orderId}::uuid AND rater_id=${userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      const now = await databaseTimeAfterLock(tx);
      if (now > row.rows[0].edit_until) throw new Error('RATING_WINDOW_EXPIRED');
      await sql`UPDATE ratings SET stars=${input.stars},comment=${comment},updated_at=clock_timestamp() WHERE id=${ratingId}::uuid`.execute(
        tx,
      );
      await this.low(tx, ratingId, userId, orderId, input.stars);
    });
  }
  async moderate(
    actorId: string,
    ratingId: string,
    hidden: boolean,
    reason: string,
  ): Promise<void> {
    if (typeof hidden !== 'boolean' || !reason.trim() || reason.length > 300)
      throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      const actor =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('SUPPORT_AGENT','ADMIN','SUPER_ADMIN') FOR SHARE OF u,r`.execute(
          tx,
        );
      if (!actor.rows.length) throw new Error('FORBIDDEN');
      const result =
        await sql`UPDATE ratings SET hidden=${hidden},updated_at=clock_timestamp() WHERE id=${ratingId}::uuid RETURNING id`.execute(
          tx,
        );
      if (!result.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actorId}::uuid,'rating.moderated','rating',${ratingId},${JSON.stringify({ hidden, reason })}::jsonb)`.execute(
        tx,
      );
    });
  }
  async aggregate(
    targetType: RatingTarget,
    targetId: string,
  ): Promise<{ count: number; average: number } | null> {
    const result = await sql<{
      count: string;
      average: string;
    }>`SELECT COUNT(*)::text AS count,AVG(stars)::text AS average FROM ratings WHERE target_type=${targetType} AND target_id=${targetId}::uuid AND NOT hidden`.execute(
      this.db,
    );
    const count = Number(result.rows[0]?.count ?? '0');
    if (count < (await this.config.get('ratingAggregateMinimumCount'))) return null;
    return { count, average: Number(result.rows[0]!.average) };
  }
}
