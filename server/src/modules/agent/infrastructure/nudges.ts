import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json } from '../../../platform/database/database.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { OrderOperations } from '../../orders/contracts/orders.js';
import { AGENT_DISCLOSURE_VERSION } from '../contracts/agent.js';
import { sanitizeAgentText } from './guards.js';
import { assertAgentCommitAllowed, requireAgentPermission } from './security.js';

const NUDGE_EVENT_TYPE = 'AGENT_REORDER_NUDGE';
const NUDGE_TEMPLATE_KEY = 'agent.reorder_nudge';
/** Trigger point: 80% of the median cadence elapsed since the last purchase. */
const NUDGE_DUE_FACTOR = 0.8;
const MIN_PURCHASES = 3;
const RECENT_NUDGE_DAYS = 7;
const IGNORED_NUDGE_LIMIT = 3;
const SWEEP_USER_LIMIT = 50;
const HISTORY_ORDER_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurchaseHistory {
  name: string;
  dates: Date[];
}
export interface NudgeCandidate {
  variantId: string;
  productName: string;
  lastPurchase: Date;
}

/** Median gap between consecutive purchase dates; null before two purchases. */
export function medianIntervalMs(dates: readonly Date[]): number | null {
  const times = dates.map((date) => date.getTime()).sort((a, b) => a - b);
  const gaps = times
    .slice(1)
    .map((time, index) => time - times[index]!)
    .sort((a, b) => a - b);
  if (!gaps.length) return null;
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1
    ? gaps[middle]!
    : Math.round((gaps[middle - 1]! + gaps[middle]!) / 2);
}

/** 80% of the median cadence elapsed since the last purchase triggers a nudge. */
export function isReorderDue(lastPurchase: Date, medianMs: number, now: Date): boolean {
  return now.getTime() >= lastPurchase.getTime() + NUDGE_DUE_FACTOR * medianMs;
}

/**
 * Pure candidate pick: at least three purchases, a usable cadence (median > 0,
 * so purchases bunched inside one cadence window are skipped), not already in
 * the cart or on an active order, and past 0.8× the median interval. Most
 * overdue first; the caller applies the remaining weekly budget as `limit`.
 */
export function selectReorderCandidates(input: {
  history: ReadonlyMap<string, PurchaseHistory>;
  cartVariantIds: ReadonlySet<string>;
  activeVariantIds: ReadonlySet<string>;
  now: Date;
  limit: number;
}): NudgeCandidate[] {
  const due: (NudgeCandidate & { overdueMs: number })[] = [];
  for (const [variantId, entry] of input.history) {
    if (entry.dates.length < MIN_PURCHASES) continue;
    if (input.cartVariantIds.has(variantId)) continue;
    if (input.activeVariantIds.has(variantId)) continue;
    const median = medianIntervalMs(entry.dates);
    if (median === null || median <= 0) continue;
    const lastPurchase = entry.dates.reduce((latest, date) =>
      date.getTime() > latest.getTime() ? date : latest,
    );
    if (!isReorderDue(lastPurchase, median, input.now)) continue;
    due.push({
      variantId,
      productName: entry.name,
      lastPurchase,
      overdueMs: input.now.getTime() - (lastPurchase.getTime() + NUDGE_DUE_FACTOR * median),
    });
  }
  return due
    .sort((a, b) => b.overdueMs - a.overdueMs)
    .slice(0, Math.max(0, input.limit))
    .map(({ overdueMs: _overdueMs, ...candidate }) => candidate);
}

/** Weekly budget window: the current ISO week, Monday 00:00 UTC. */
export function utcWeekStart(now: Date): Date {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday),
  );
}

/**
 * Reorder nudges: the preference write (agent tool, audited and replayed by
 * the model's tool-call id) and the scheduled proactive sweep that appends
 * AGENT_REORDER_NUDGE events for the notifications consumer.
 */
export class AgentNudges {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderOperations,
    private readonly cart: CartService,
    private readonly catalog: CatalogQuery,
    private readonly addresses: AddressOperations,
    private readonly config: AppConfig,
  ) {}

  async setPreference(
    userId: string,
    enabled: boolean,
    threadId: string,
    toolCallId: string,
  ): Promise<{ enabled: boolean }> {
    if (!toolCallId || toolCallId.length > 200) throw new Error('INVALID_INPUT');
    const hash = hashCanonical({ enabled });
    const result = { enabled };
    return this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      await requireAgentPermission(userId, tx);
      const thread = await sql<{
        status: string;
      }>`SELECT status FROM agent_threads WHERE id=${threadId}::uuid AND user_id=${userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!thread.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (thread.rows[0].status !== 'active') throw new Error('THREAD_ARCHIVED');
      await assertAgentCommitAllowed(tx, userId, threadId);
      const prior = await sql<{
        request_hash: string;
        result: Json;
      }>`SELECT request_hash,result FROM agent_tool_operations WHERE thread_id=${threadId}::uuid AND user_id=${userId}::uuid AND tool_call_id=${toolCallId}`.execute(
        tx,
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return prior.rows[0].result as { enabled: boolean };
      }
      await sql`INSERT INTO agent_nudge_preferences(user_id,enabled,ignored_count,updated_at) VALUES (${userId}::uuid,${enabled},0,clock_timestamp()) ON CONFLICT (user_id) DO UPDATE SET enabled=${enabled},ignored_count=CASE WHEN ${enabled} THEN 0 ELSE agent_nudge_preferences.ignored_count END,updated_at=clock_timestamp()`.execute(
        tx,
      );
      await sql`INSERT INTO agent_tool_operations(thread_id,tool_call_id,user_id,request_hash,result) VALUES(${threadId}::uuid,${toolCallId},${userId}::uuid,${hash},${JSON.stringify(result)}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${userId}::uuid,'AGENT_NUDGE_PREFERENCE','user',${userId},${JSON.stringify({ source: 'AGENT', threadId, enabled })}::jsonb)`.execute(
        tx,
      );
      return result;
    });
  }

  /** Scheduled job body: one bounded pass over the opted-in population. */
  async runSweep(now: Date): Promise<{ checked: number; sent: number }> {
    if (!(await this.config.get('agent_proactive_nudges_enabled'))) return { checked: 0, sent: 0 };
    // Modest worker throughput: a sweep touches at most the 50 longest-waiting
    // opted-in users (oldest preference update first), so a large opt-in
    // population drains over repeated passes instead of one long job.
    const optedIn = await sql<{
      user_id: string;
    }>`SELECT user_id FROM agent_nudge_preferences WHERE enabled ORDER BY updated_at ASC, user_id ASC LIMIT ${SWEEP_USER_LIMIT}`.execute(
      this.db,
    );
    let sent = 0;
    for (let index = 0; index < optedIn.rows.length; index++)
      sent += await this.sweepUser(optedIn.rows[index]!.user_id, now);
    return { checked: optedIn.rows.length, sent };
  }

  private async sweepUser(userId: string, now: Date): Promise<number> {
    const maxPerWeek = await this.config.get('agent_nudge_max_per_week');
    const weekStart = utcWeekStart(now);
    // Recipient and template key live on notifications; notification_deliveries
    // only mirrors per-channel provider attempts (migrations 010/013 carry no
    // recipient or event columns). The plan's channels always include PUSH, so
    // PUSH rows count AGENT_REORDER_NUDGE nudges one-for-one.
    const weekly = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM notifications WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE_KEY} AND channel='PUSH' AND created_at >= ${weekStart.toISOString()}`.execute(
      this.db,
    );
    const remaining = maxPerWeek - Number(weekly.rows[0]?.count ?? 0);
    if (remaining <= 0) {
      await this.rotate(userId);
      return 0;
    }
    const unread = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM notifications WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE_KEY} AND channel='INBOX' AND status='SENT' AND read_at IS NULL`.execute(
      this.db,
    );
    if (Number(unread.rows[0]?.count ?? 0) >= IGNORED_NUDGE_LIMIT) {
      await sql`UPDATE agent_nudge_preferences SET enabled=false,ignored_count=${IGNORED_NUDGE_LIMIT},updated_at=clock_timestamp() WHERE user_id=${userId}::uuid`.execute(
        this.db,
      );
      return 0;
    }
    const signals = await this.orders.purchaseSignals(userId, HISTORY_ORDER_LIMIT);
    const { history, activeVariantIds } = historyFromSignals(
      signals.delivered,
      signals.activeVariantIds,
    );
    if (history.size === 0) {
      await this.rotate(userId);
      return 0;
    }
    const cart = await this.cart.get(userId);
    const addressId =
      cart?.addressId ??
      (await this.addresses.list(userId)).find((address) => address.isDefault)?.id;
    if (!addressId) {
      await this.rotate(userId);
      return 0;
    }
    const candidates = selectReorderCandidates({
      history,
      cartVariantIds: new Set((cart?.lines ?? []).map((line) => line.variantId)),
      activeVariantIds,
      now,
      limit: remaining,
    });
    let sent = 0;
    for (const candidate of candidates) {
      if (await this.nudgedRecently(userId, candidate.variantId, now)) continue;
      if (!(await this.inStock(userId, addressId, candidate))) continue;
      const inserted = await this.appendNudgeEvent(userId, candidate, now, maxPerWeek);
      if (inserted) sent += 1;
    }
    await this.rotate(userId);
    return sent;
  }

  /** Move this opted-in customer behind the others so the next sweep is not the same 50. */
  private async rotate(userId: string): Promise<void> {
    await sql`UPDATE agent_nudge_preferences SET updated_at=clock_timestamp() WHERE user_id=${userId}::uuid AND enabled`.execute(
      this.db,
    );
  }

  private async nudgedRecently(userId: string, variantId: string, now: Date): Promise<boolean> {
    const recentCutoff = new Date(now.getTime() - RECENT_NUDGE_DAYS * DAY_MS);
    const recent =
      await sql`SELECT 1 FROM notifications WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE_KEY} AND COALESCE(payload->'data'->>'variantId',payload->>'variantId')=${variantId} AND created_at >= ${recentCutoff.toISOString()}
      UNION ALL SELECT 1 FROM outbox_events WHERE event_type=${NUDGE_EVENT_TYPE} AND payload->>'userId'=${userId} AND payload->>'variantId'=${variantId} AND occurred_at >= ${recentCutoff.toISOString()} LIMIT 1`.execute(
        this.db,
      );
    return recent.rows.length > 0;
  }

  /** Stock read through the agent's existing catalog search at the user's store. */
  private async inStock(
    userId: string,
    addressId: string,
    candidate: NudgeCandidate,
  ): Promise<boolean> {
    const result = await this.catalog.list(userId, addressId, {
      q: candidate.productName,
      limit: 8,
    });
    const match = result.items.find(
      (item) => (item as Record<string, unknown>).variantId === candidate.variantId,
    );
    return (
      match !== undefined && (match as Record<string, unknown>).availability !== 'OUT_OF_STOCK'
    );
  }

  private async appendNudgeEvent(
    userId: string,
    candidate: NudgeCandidate,
    now: Date,
    maxPerWeek: number,
  ): Promise<boolean> {
    const week = utcWeekStart(now).toISOString().slice(0, 10);
    const aggregateId = stableUuid(`${userId}:${candidate.variantId}:${week}`);
    try {
      return await this.db.transaction().execute(async (tx) => {
        // Serialize scheduling with the customer's opt-out and other workers.
        const user =
          await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
            tx,
          );
        if (!user.rows.length) return false;
        const permission = await sql<{ allowed: boolean }>`SELECT
          COALESCE((SELECT enabled FROM feature_flags WHERE key='agent_enabled'),false)
          AND COALESCE((SELECT value='true'::jsonb FROM app_config WHERE key='agent_proactive_nudges_enabled'),false)
          AND EXISTS (SELECT 1 FROM consents WHERE user_id=${userId}::uuid AND type='ai_assistant' AND version=${AGENT_DISCLOSURE_VERSION} AND revoked_at IS NULL)
          AND COALESCE((SELECT enabled FROM agent_nudge_preferences WHERE user_id=${userId}::uuid),false)
          AND COALESCE((SELECT enabled FROM notification_preferences WHERE user_id=${userId}::uuid AND category='PROMOTIONS'),true) AS allowed`.execute(
          tx,
        );
        if (!permission.rows[0]?.allowed) return false;
        const weekly = await sql<{
          count: string;
        }>`SELECT count(DISTINCT logical_id)::text AS count FROM (
          SELECT aggregate_id::text AS logical_id FROM outbox_events
            WHERE event_type=${NUDGE_EVENT_TYPE} AND payload->>'userId'=${userId} AND occurred_at >= ${utcWeekStart(now).toISOString()}
          UNION ALL
          SELECT split_part(dedupe_key,'|',4) AS logical_id FROM notifications
            WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE_KEY} AND channel='PUSH' AND created_at >= ${utcWeekStart(now).toISOString()}
        ) reminders`.execute(tx);
        if (Number(weekly.rows[0]?.count ?? 0) >= maxPerWeek) return false;
        const recentCutoff = new Date(now.getTime() - RECENT_NUDGE_DAYS * DAY_MS).toISOString();
        const recent =
          await sql`SELECT 1 FROM notifications WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE_KEY}
          AND COALESCE(payload->'data'->>'variantId',payload->>'variantId')=${candidate.variantId} AND created_at >= ${recentCutoff}
          UNION ALL SELECT 1 FROM outbox_events WHERE event_type=${NUDGE_EVENT_TYPE} AND payload->>'userId'=${userId}
          AND payload->>'variantId'=${candidate.variantId} AND occurred_at >= ${recentCutoff} LIMIT 1`.execute(
            tx,
          );
        if (recent.rows.length) return false;
        await appendEvent(
          tx,
          {
            eventId: uuidV7(),
            eventType: NUDGE_EVENT_TYPE,
            schemaVersion: 1,
            aggregateType: 'agent_nudge',
            aggregateId,
            aggregateVersion: '1',
            occurredAt: now.toISOString(),
            correlationId: userId,
            causationId: null,
            payload: { userId, variantId: candidate.variantId, productName: candidate.productName },
          },
          ['notifications'],
        );
        return true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/duplicate|unique/i.test(message)) return false;
      throw error;
    }
  }
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function historyFromSignals(
  delivered: readonly { orderId: string; variantId: string; name: string; placedAt: string }[],
  activeVariantIds: readonly string[],
): { history: Map<string, PurchaseHistory>; activeVariantIds: Set<string> } {
  const history = new Map<string, PurchaseHistory>();
  const seen = new Set<string>();
  for (const line of delivered) {
    const key = `${line.orderId}\u0000${line.variantId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = history.get(line.variantId) ?? {
      name: sanitizeAgentText(line.name, 160),
      dates: [],
    };
    entry.dates.push(new Date(line.placedAt));
    history.set(line.variantId, entry);
  }
  return { history, activeVariantIds: new Set(activeVariantIds) };
}
