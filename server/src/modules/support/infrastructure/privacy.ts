import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { P11Privacy } from '../contracts/privacy.js';
export class PostgresP11Privacy implements P11Privacy {
  constructor(private readonly db: Database) {}
  async exportForUser(
    userId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
    let kind = '',
      id = '00000000-0000-0000-0000-000000000000';
    if (cursor) {
      try {
        const c: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          !Array.isArray(c) ||
          c.length !== 2 ||
          typeof c[0] !== 'string' ||
          !['correction', 'message', 'payout', 'rating', 'ticket'].includes(c[0]) ||
          typeof c[1] !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(c[1])
        )
          throw new Error();
        [kind, id] = c as [string, string];
      } catch {
        throw new Error('INVALID_CURSOR');
      }
    }
    const rows = await sql<{
      kind: string;
      id: string;
      data: unknown;
    }>`SELECT kind,id::text,data FROM (
   SELECT 'ticket'::text AS kind,t.id,jsonb_build_object('id',t.id,'orderId',t.order_id,'category',t.category,'status',t.status,'createdAt',t.created_at) AS data FROM support_tickets t WHERE t.owner_id=${userId}::uuid
   UNION ALL SELECT 'message',m.id,jsonb_build_object('id',m.id,'ticketId',m.ticket_id,'body',m.body,'createdAt',m.created_at) FROM support_ticket_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE t.owner_id=${userId}::uuid AND NOT m.internal
   UNION ALL SELECT 'rating',r.id,jsonb_build_object('id',r.id,'orderId',r.order_id,'targetType',r.target_type,'targetId',r.target_id,'stars',r.stars,'comment',r.comment,'createdAt',r.created_at) FROM ratings r WHERE r.rater_id=${userId}::uuid
   UNION ALL SELECT 'payout',p.id,jsonb_build_object('id',p.id,'state',p.state,'grossPaise',p.gross_paise::text,'cashOffsetPaise',p.cash_offset_paise::text,'netPaise',p.net_paise::text,'createdAt',p.created_at) FROM rider_payouts p WHERE p.rider_id=${userId}::uuid
   UNION ALL SELECT 'correction',c.id,jsonb_build_object('id',c.id,'payoutId',c.payout_id,'deltaPaise',c.delta_paise::text,'state',c.state,'createdAt',c.created_at) FROM payout_corrections c JOIN rider_payouts p ON p.id=c.payout_id WHERE p.rider_id=${userId}::uuid
  ) x WHERE (kind,id)>(${kind},${id}::uuid) ORDER BY kind,id LIMIT ${limit + 1}`.execute(this.db);
    const selected = rows.rows.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map((row) => ({ kind: row.kind, data: row.data })),
      nextCursor:
        rows.rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.kind, last.id])).toString('base64url')
          : null,
    };
  }
  async anonymizeUser(userId: string, tx: TransactionContext): Promise<void> {
    await sql`UPDATE support_ticket_messages SET body='[erased]' WHERE author_id=${userId}::uuid OR ticket_id IN (SELECT id FROM support_tickets WHERE owner_id=${userId}::uuid)`.execute(
      tx,
    );
    await sql`UPDATE ratings SET comment=NULL WHERE rater_id=${userId}::uuid AND comment IS NOT NULL`.execute(
      tx,
    );
  }
}
