import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import type { CheckoutOperations } from '../../checkout/contracts/checkout.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { addDays, nextOccurrence, type FrequencyRule } from '../domain/schedule.js';

interface Due {
  id: string;
  user_id: string;
  store_id: string;
  delivery_date: string;
  claim_token?: string;
}
interface Locked extends Due {
  address_id: string;
  variant_id: string;
  start_date: string;
  end_date: string | null;
  status: string;
  failure_streak: number;
  last_unit_price_paise: string | null;
  quantity: string;
  frequency_rule: FrequencyRule;
  slot_start: string;
  slot_end: string;
  plan_active: boolean;
  slot_active: boolean;
}

/** Persistent occurrence row is the idempotency boundary; each delivery owns a separate transaction. */
export class SubscriptionGeneration {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private async withWorker<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
  constructor(
    private readonly db: Database,
    private readonly checkout: CheckoutOperations,
    private readonly config: AppConfig,
  ) {}
  async scan(limit = 100, storeId?: string): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('INVALID_INPUT');
    await this.pauseDisabledAccounts(limit);
    const time = await this.config.get('subscriptionGenerationTime');
    let total = 0;
    while (total < limit) {
      const token = uuidV7();
      const due = await this.db.transaction().execute(async (tx) => {
        return (
          await sql<Due>`WITH selected AS (
          SELECT s.id FROM subscriptions s JOIN users u ON u.id=s.user_id AND u.status='ACTIVE' AND u.pool='CUSTOMER'
          WHERE s.status='ACTIVE' AND s.next_delivery_date IS NOT NULL AND (${storeId ?? null}::uuid IS NULL OR s.store_id=${storeId ?? null}::uuid)
          AND (s.generation_claim_until IS NULL OR s.generation_claim_until<=clock_timestamp())
          AND (s.next_delivery_date <= (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date OR
            (s.next_delivery_date = (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1 AND (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::time >= ${time}::time))
          AND NOT EXISTS(SELECT 1 FROM subscription_occurrences o WHERE o.subscription_id=s.id AND o.delivery_date=s.next_delivery_date AND (o.state IN ('ORDERED','SKIPPED') OR (o.state IN ('PENDING','RETRYABLE') AND o.retry_at>clock_timestamp())))
          ORDER BY s.store_id,s.next_delivery_date,s.id FOR UPDATE OF s SKIP LOCKED LIMIT ${Math.min(limit - total, 25)}
        ) UPDATE subscriptions s SET generation_claim_token=${token}::uuid,generation_claim_until=clock_timestamp()+interval '120 seconds' FROM selected WHERE s.id=selected.id RETURNING s.id::text,s.user_id::text,s.store_id::text,s.next_delivery_date::text AS delivery_date,s.generation_claim_token::text AS claim_token`.execute(
            tx,
          )
        ).rows;
      });
      if (!due.length) break;
      total += due.length;
      for (let offset = 0; offset < due.length; offset += 5)
        await Promise.all(
          due.slice(offset, offset + 5).map((row) =>
            this.withWorker(async () => {
              try {
                await this.process(row);
              } catch {
                /* next lease or retry scan recovers work */
              } finally {
                await sql`UPDATE subscriptions SET generation_claim_token=NULL,generation_claim_until=NULL WHERE id=${row.id}::uuid AND generation_claim_token=${row.claim_token}::uuid`.execute(
                  this.db,
                );
              }
            }),
          ),
        );
    }
    await sql`UPDATE subscription_generation_runs r SET status=CASE WHEN EXISTS(SELECT 1 FROM subscription_occurrences o WHERE o.run_id=r.id AND o.state IN ('PENDING','RETRYABLE')) OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.store_id=r.store_id AND s.status='ACTIVE' AND s.next_delivery_date=r.delivery_date) THEN 'INCOMPLETE' ELSE 'COMPLETE' END,updated_at=clock_timestamp() WHERE r.status IN ('PENDING','RUNNING','INCOMPLETE') AND (${storeId ?? null}::uuid IS NULL OR r.store_id=${storeId ?? null}::uuid)`.execute(
      this.db,
    );
    return total;
  }
  async scanStores(perStoreLimit = 100, storeLimit = 100): Promise<number> {
    if (
      !Number.isInteger(storeLimit) ||
      storeLimit < 1 ||
      storeLimit > 1000 ||
      !Number.isInteger(perStoreLimit) ||
      perStoreLimit < 1 ||
      perStoreLimit > 10000
    )
      throw new Error('INVALID_INPUT');
    await this.pauseDisabledAccounts(perStoreLimit);
    const generationTime = await this.config.get('subscriptionGenerationTime');
    const stores = await sql<{
      id: string;
    }>`SELECT DISTINCT s.store_id::text AS id FROM subscriptions s JOIN users u ON u.id=s.user_id AND u.status='ACTIVE' AND u.pool='CUSTOMER' WHERE s.status='ACTIVE' AND s.next_delivery_date IS NOT NULL AND (s.generation_claim_until IS NULL OR s.generation_claim_until<=clock_timestamp()) AND (s.next_delivery_date <= (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date OR (s.next_delivery_date = (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1 AND (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::time >= ${generationTime}::time)) AND NOT EXISTS(SELECT 1 FROM subscription_occurrences o WHERE o.subscription_id=s.id AND o.delivery_date=s.next_delivery_date AND (o.state IN ('ORDERED','SKIPPED') OR (o.state IN ('PENDING','RETRYABLE') AND o.retry_at>clock_timestamp()))) ORDER BY id LIMIT ${storeLimit}`.execute(
      this.db,
    );
    let total = 0;
    for (let index = 0; index < stores.rows.length; index += 5) {
      const counts = await Promise.all(
        stores.rows.slice(index, index + 5).map((store) => this.scan(perStoreLimit, store.id)),
      );
      total += counts.reduce((sum, n) => sum + n, 0);
    }
    return total;
  }
  private async pauseDisabledAccounts(limit: number) {
    const users = await sql<{
      id: string;
    }>`SELECT DISTINCT s.user_id::text AS id FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.status='ACTIVE' AND (u.status<>'ACTIVE' OR u.pool<>'CUSTOMER') ORDER BY id LIMIT ${limit}`.execute(
      this.db,
    );
    for (const user of users.rows)
      await transactionWithRetry(this.db, async (tx) => {
        const account = await sql<{
          status: string;
          pool: string;
        }>`SELECT status,pool FROM users WHERE id=${user.id}::uuid FOR UPDATE`.execute(tx);
        if (
          !account.rows[0] ||
          (account.rows[0].status === 'ACTIVE' && account.rows[0].pool === 'CUSTOMER')
        )
          return;
        const subs = await sql<{
          id: string;
          delivery_date: string | null;
        }>`SELECT id::text,next_delivery_date::text AS delivery_date FROM subscriptions WHERE user_id=${user.id}::uuid AND status='ACTIVE' ORDER BY id FOR UPDATE`.execute(
          tx,
        );
        for (const s of subs.rows) {
          await sql`UPDATE subscriptions SET status='PAUSED',updated_at=clock_timestamp() WHERE id=${s.id}::uuid`.execute(
            tx,
          );
          await appendEvent(
            tx,
            {
              eventId: uuidV7(),
              eventType: 'subscription.generation_incomplete',
              schemaVersion: 1,
              aggregateType: 'subscription',
              aggregateId: s.id,
              aggregateVersion: '1',
              occurredAt: new Date().toISOString(),
              correlationId: s.id,
              causationId: null,
              payload: { subscriptionId: s.id, reason: 'ACCOUNT_DISABLED' },
            },
            ['notifications'],
          );
        }
      });
  }
  private async alert(
    tx: TransactionContext,
    s: Locked,
    kind: 'LOW_BALANCE' | 'PRICE_INCREASE',
    amountPaise: string,
  ) {
    const id = uuidV7();
    const inserted =
      await sql`INSERT INTO subscription_alerts(id,subscription_id,delivery_date,kind) VALUES(${id}::uuid,${s.id}::uuid,${s.delivery_date}::date,${kind}) ON CONFLICT DO NOTHING RETURNING id`.execute(
        tx,
      );
    if (!inserted.rows.length) return;
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType:
          kind === 'LOW_BALANCE' ? 'subscription.low_balance' : 'subscription.price_increase',
        schemaVersion: 1,
        aggregateType: 'subscription_alert',
        aggregateId: id,
        aggregateVersion: '1',
        occurredAt: new Date().toISOString(),
        correlationId: s.id,
        causationId: null,
        payload: {
          subscriptionId: s.id,
          userId: s.user_id,
          deliveryDate: s.delivery_date,
          amountPaise,
        },
      },
      ['notifications'],
    );
  }
  async forecast(limit = 100) {
    const candidates =
      await sql<Due>`SELECT s.id::text,s.user_id::text,s.store_id::text,s.next_delivery_date::text AS delivery_date FROM subscriptions s WHERE s.status='ACTIVE' AND s.next_delivery_date BETWEEN (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date AND (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+2 AND (s.forecast_checked_at IS NULL OR s.forecast_checked_at < clock_timestamp() - interval '1 hour') AND NOT EXISTS(SELECT 1 FROM subscription_alerts a WHERE a.subscription_id=s.id AND a.delivery_date=s.next_delivery_date AND a.kind='LOW_BALANCE') ORDER BY s.forecast_checked_at NULLS FIRST,s.next_delivery_date,s.id LIMIT ${limit}`.execute(
        this.db,
      );
    for (const due of candidates.rows)
      await transactionWithRetry(this.db, async (tx) => {
        const s = await this.locked(tx, due);
        if (!s) return;
        const start = new Date(`${s.delivery_date}T${s.slot_start}+05:30`).toISOString(),
          end = new Date(`${s.delivery_date}T${s.slot_end}+05:30`).toISOString();
        const price = await this.checkout.priceScheduled(
          {
            userId: s.user_id,
            subscriptionId: s.id,
            deliveryDate: s.delivery_date,
            storeId: s.store_id,
            addressId: s.address_id,
            variantId: s.variant_id,
            quantity: s.quantity,
            slotStart: start,
            slotEnd: end,
          },
          tx,
        );
        const balance = await sql<{
          cash: string;
          promo: string;
        }>`SELECT COALESCE(a.cash_balance_paise,0)::text AS cash,COALESCE((SELECT sum(l.remaining_paise) FROM wallet_promo_lots l WHERE l.account_id=a.id AND l.state='ACTIVE' AND (l.expires_at IS NULL OR l.expires_at>clock_timestamp())),0)::text AS promo FROM wallet_accounts a WHERE a.user_id=${s.user_id}::uuid`.execute(
          tx,
        );
        const total = BigInt(price.totalPaise),
          cap = BigInt(await this.config.get('promoSpendCapBps', tx));
        const cash = BigInt(balance.rows[0]?.cash ?? '0'),
          promo = BigInt(balance.rows[0]?.promo ?? '0'),
          usable = (total * cap) / 10000n;
        if (cash + (promo < usable ? promo : usable) < total)
          await this.alert(tx, s, 'LOW_BALANCE', price.totalPaise);
        await sql`UPDATE subscriptions SET forecast_checked_at=clock_timestamp() WHERE id=${s.id}::uuid`.execute(
          tx,
        );
      }).catch(() => undefined);
  }
  private async locked(tx: TransactionContext, due: Due): Promise<Locked | undefined> {
    await lockActiveCustomer(due.user_id, tx);
    const sub =
      await sql`SELECT id FROM subscriptions WHERE id=${due.id}::uuid AND user_id=${due.user_id}::uuid FOR UPDATE`.execute(
        tx,
      );
    if (!sub.rows.length) return undefined;
    if (due.claim_token) {
      const owned =
        await sql`SELECT 1 FROM subscriptions WHERE id=${due.id}::uuid AND generation_claim_token=${due.claim_token}::uuid AND generation_claim_until>clock_timestamp()`.execute(
          tx,
        );
      if (!owned.rows.length) return undefined;
    }
    const result =
      await sql<Locked>`SELECT s.id::text,s.user_id::text,s.store_id::text,COALESCE(sv.address_id,s.address_id)::text AS address_id,p.variant_id::text,
      s.start_date::text,s.end_date::text,s.status,s.failure_streak,s.last_unit_price_paise::text,sv.quantity::text,sv.frequency_rule,
      sl.start_time::text AS slot_start,sl.end_time::text AS slot_end,p.active AS plan_active,sl.active AS slot_active,${due.delivery_date}::text AS delivery_date
      FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
      JOIN LATERAL (SELECT * FROM subscription_schedule_versions v WHERE v.subscription_id=s.id AND v.effective_from<=${due.delivery_date}::date ORDER BY v.effective_from DESC LIMIT 1) sv ON true
      JOIN subscription_slots sl ON sl.id=sv.slot_id WHERE s.id=${due.id}::uuid AND s.status='ACTIVE' AND s.next_delivery_date=${due.delivery_date}::date`.execute(
        tx,
      );
    return result.rows[0];
  }
  private async process(due: Due): Promise<void> {
    try {
      await transactionWithRetry(this.db, async (tx) => {
        const s = await this.locked(tx, due);
        if (!s) return;
        const runId = uuidV7();
        const run = await sql<{
          id: string;
        }>`INSERT INTO subscription_generation_runs(id,store_id,delivery_date,status) VALUES(${runId}::uuid,${s.store_id}::uuid,${s.delivery_date}::date,'RUNNING') ON CONFLICT(store_id,delivery_date) DO UPDATE SET updated_at=clock_timestamp() RETURNING id::text`.execute(
          tx,
        );
        await sql`INSERT INTO subscription_occurrences(id,subscription_id,delivery_date,run_id) VALUES(${uuidV7()}::uuid,${s.id}::uuid,${s.delivery_date}::date,${run.rows[0]!.id}::uuid) ON CONFLICT(subscription_id,delivery_date) DO NOTHING`.execute(
          tx,
        );
        const occurrence = await sql<{
          id: string;
          state: string;
          retry_at: Date | null;
          retry_deadline: Date | null;
          now: Date;
        }>`SELECT id::text,state,retry_at,retry_deadline,clock_timestamp() AS now FROM subscription_occurrences WHERE subscription_id=${s.id}::uuid AND delivery_date=${s.delivery_date}::date FOR UPDATE`.execute(
          tx,
        );
        const o = occurrence.rows[0]!;
        if (o.state === 'ORDERED' || o.state === 'SKIPPED') return;
        if (o.state === 'RETRYABLE' && o.retry_at && o.now < o.retry_at) return;
        const exceptions = await sql<{
          skipped: boolean;
          paused: boolean;
          holiday: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM subscription_skips WHERE subscription_id=${s.id}::uuid AND delivery_date=${s.delivery_date}::date) AS skipped, EXISTS(SELECT 1 FROM subscription_pauses WHERE subscription_id=${s.id}::uuid AND ${s.delivery_date}::date BETWEEN starts_on AND ends_on) AS paused, EXISTS(SELECT 1 FROM subscription_holidays WHERE store_id=${s.store_id}::uuid AND holiday_date=${s.delivery_date}::date) AS holiday`.execute(
          tx,
        );
        const flags = exceptions.rows[0]!;
        if (
          flags.skipped ||
          flags.paused ||
          flags.holiday ||
          (o.retry_deadline && o.now >= o.retry_deadline)
        ) {
          const reason = flags.skipped
            ? 'SKIPPED_CUSTOMER'
            : flags.paused
              ? 'SKIPPED_PAUSED'
              : flags.holiday
                ? 'SKIPPED_HOLIDAY'
                : 'SKIPPED_INSUFFICIENT_BALANCE';
          if (
            reason === 'SKIPPED_HOLIDAY' &&
            s.end_date &&
            (await this.config.get('subscriptionExtendOnHoliday', tx))
          ) {
            s.end_date = addDays(s.end_date, 1);
            await sql`UPDATE subscriptions SET end_date=${s.end_date}::date WHERE id=${s.id}::uuid`.execute(
              tx,
            );
          }
          await this.finish(tx, s, o.id, reason);
          return;
        }
        if (!s.plan_active || !s.slot_active) {
          await sql`UPDATE subscriptions SET status='PAUSED',updated_at=clock_timestamp() WHERE id=${s.id}::uuid`.execute(
            tx,
          );
          await sql`UPDATE subscription_occurrences SET state='SKIPPED',reason=${!s.plan_active ? 'PLAN_DISABLED' : 'SLOT_DISABLED'},updated_at=clock_timestamp() WHERE id=${o.id}::uuid`.execute(
            tx,
          );
          await appendEvent(
            tx,
            {
              eventId: uuidV7(),
              eventType: 'subscription.skipped',
              schemaVersion: 1,
              aggregateType: 'subscription_occurrence',
              aggregateId: o.id,
              aggregateVersion: '1',
              occurredAt: new Date().toISOString(),
              correlationId: s.id,
              causationId: null,
              payload: {
                subscriptionId: s.id,
                userId: s.user_id,
                deliveryDate: s.delivery_date,
                reason: !s.plan_active ? 'PLAN_DISABLED' : 'SLOT_DISABLED',
              },
            },
            ['notifications'],
          );
          return;
        }
        const slotStart = new Date(`${s.delivery_date}T${s.slot_start}+05:30`).toISOString();
        const slotEnd = new Date(`${s.delivery_date}T${s.slot_end}+05:30`).toISOString();
        if (new Date(slotStart) <= o.now) {
          await this.finish(tx, s, o.id, 'SKIPPED_MISSED_SLOT');
          return;
        }
        const order = await this.checkout.placeScheduled(
          {
            userId: s.user_id,
            subscriptionId: s.id,
            deliveryDate: s.delivery_date,
            storeId: s.store_id,
            addressId: s.address_id,
            variantId: s.variant_id,
            quantity: s.quantity,
            slotStart,
            slotEnd,
          },
          tx,
        );
        await sql`UPDATE subscription_occurrences SET state='ORDERED',order_id=${order.orderId}::uuid,updated_at=clock_timestamp() WHERE id=${o.id}::uuid`.execute(
          tx,
        );
        const threshold = await this.config.get('subscriptionPriceIncreaseAlertBps', tx);
        if (
          s.last_unit_price_paise !== null &&
          BigInt(order.unitPricePaise) * 10000n >
            BigInt(s.last_unit_price_paise) * BigInt(10000 + threshold)
        ) {
          await this.alert(tx, s, 'PRICE_INCREASE', order.totalPaise);
        }

        await this.advance(tx, s);
        await sql`UPDATE subscriptions SET failure_streak=0,last_unit_price_paise=${order.unitPricePaise}::bigint WHERE id=${s.id}::uuid`.execute(
          tx,
        );
      });
    } catch (error) {
      await this.recordFailure(due, error instanceof Error ? error.message : 'UNKNOWN');
    }
  }
  private async advance(tx: TransactionContext, s: Locked) {
    const from = addDays(s.delivery_date, 1);
    const versions = await sql<{
      frequency_rule: FrequencyRule;
      effective_from: string;
    }>`SELECT frequency_rule,effective_from::text FROM subscription_schedule_versions WHERE subscription_id=${s.id}::uuid AND (effective_from>${from}::date OR effective_from=(SELECT max(effective_from) FROM subscription_schedule_versions WHERE subscription_id=${s.id}::uuid AND effective_from<=${from}::date)) ORDER BY effective_from`.execute(
      tx,
    );
    let next: string | null = null;
    for (let i = 0; i < versions.rows.length; i++) {
      const version = versions.rows[i]!,
        start = version.effective_from > from ? version.effective_from : from;
      const boundary = versions.rows[i + 1]?.effective_from,
        segmentEnd = boundary ? addDays(boundary, -1) : s.end_date;
      const end = s.end_date && segmentEnd && s.end_date < segmentEnd ? s.end_date : segmentEnd;
      next = nextOccurrence(s.start_date, start, version.frequency_rule, end);
      if (next) break;
    }
    await sql`UPDATE subscriptions SET next_delivery_date=${next}::date,status=CASE WHEN ${next}::date IS NULL AND end_date IS NOT NULL THEN 'COMPLETED' ELSE status END,updated_at=clock_timestamp() WHERE id=${s.id}::uuid`.execute(
      tx,
    );
  }
  private async finish(tx: TransactionContext, s: Locked, id: string, reason: string) {
    await sql`UPDATE subscription_occurrences SET state='SKIPPED',reason=${reason},updated_at=clock_timestamp() WHERE id=${id}::uuid`.execute(
      tx,
    );
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType: 'subscription.skipped',
        schemaVersion: 1,
        aggregateType: 'subscription_occurrence',
        aggregateId: id,
        aggregateVersion: '1',
        occurredAt: new Date().toISOString(),
        correlationId: s.id,
        causationId: null,
        payload: { subscriptionId: s.id, userId: s.user_id, deliveryDate: s.delivery_date, reason },
      },
      ['notifications'],
    );
    await this.advance(tx, s);
    if (reason === 'SKIPPED_INSUFFICIENT_BALANCE') {
      const n = await this.config.get('subscriptionFailurePauseThreshold', tx);
      await sql`UPDATE subscriptions SET failure_streak=failure_streak+1,status=CASE WHEN failure_streak+1>=${n} THEN 'PAUSED' ELSE status END WHERE id=${s.id}::uuid`.execute(
        tx,
      );
    }
  }
  private async recordFailure(due: Due, code: string) {
    await transactionWithRetry(this.db, async (tx) => {
      const s = await this.locked(tx, due);
      if (!s) return;
      const run = await sql<{
        id: string;
      }>`INSERT INTO subscription_generation_runs(id,store_id,delivery_date,status) VALUES(${uuidV7()}::uuid,${s.store_id}::uuid,${s.delivery_date}::date,'INCOMPLETE') ON CONFLICT(store_id,delivery_date) DO UPDATE SET status='INCOMPLETE',updated_at=clock_timestamp() RETURNING id::text`.execute(
        tx,
      );
      await sql`INSERT INTO subscription_occurrences(id,subscription_id,delivery_date,run_id) VALUES(${uuidV7()}::uuid,${s.id}::uuid,${s.delivery_date}::date,${run.rows[0]!.id}::uuid) ON CONFLICT(subscription_id,delivery_date) DO NOTHING`.execute(
        tx,
      );
      const row = await sql<{
        id: string;
        state: string;
        reason: string | null;
      }>`SELECT id::text,state,reason FROM subscription_occurrences WHERE subscription_id=${s.id}::uuid AND delivery_date=${s.delivery_date}::date FOR UPDATE`.execute(
        tx,
      );
      const o = row.rows[0]!;
      if (o.state === 'ORDERED' || o.state === 'SKIPPED') return;
      if (code === 'WALLET_INSUFFICIENT') {
        const retry = await this.config.get('subscriptionGraceRetryTime', tx),
          deadline = await this.config.get('subscriptionGraceDeadlineTime', tx);
        const updated =
          await sql`UPDATE subscription_occurrences SET state='RETRYABLE',reason=${code},retry_at=(${s.delivery_date}::date + CASE WHEN state='RETRYABLE' THEN ${deadline}::time ELSE ${retry}::time END) AT TIME ZONE 'Asia/Kolkata',retry_deadline=(${s.delivery_date}::date + ${deadline}::time) AT TIME ZONE 'Asia/Kolkata',updated_at=clock_timestamp() WHERE id=${o.id}::uuid AND clock_timestamp() < ((${s.delivery_date}::date + ${deadline}::time) AT TIME ZONE 'Asia/Kolkata') RETURNING id`.execute(
            tx,
          );
        if (!updated.rows.length) await this.finish(tx, s, o.id, 'SKIPPED_INSUFFICIENT_BALANCE');
      } else if (code === 'ADDRESS_NOT_SERVICEABLE') {
        await sql`UPDATE subscriptions SET status='PAUSED',updated_at=clock_timestamp() WHERE id=${s.id}::uuid`.execute(
          tx,
        );
        await sql`UPDATE subscription_occurrences SET state='SKIPPED',reason=${code},updated_at=clock_timestamp() WHERE id=${o.id}::uuid`.execute(
          tx,
        );
      } else if (
        [
          'ITEM_UNAVAILABLE',
          'INVENTORY_INSUFFICIENT',
          'STORE_CLOSED',
          'STORE_AT_CAPACITY',
          'MIN_ORDER_NOT_MET',
          'MAX_ORDER_EXCEEDED',
        ].includes(code)
      ) {
        await this.finish(tx, s, o.id, code);
      } else {
        // Unexpected failures remain PENDING and visible for retry and operations.
        await sql`UPDATE subscription_occurrences SET reason=${code.slice(0, 200)},retry_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=${o.id}::uuid`.execute(
          tx,
        );
        if (o.reason === null)
          await appendEvent(
            tx,
            {
              eventId: uuidV7(),
              eventType: 'subscription.generation_incomplete',
              schemaVersion: 1,
              aggregateType: 'subscription_occurrence',
              aggregateId: o.id,
              aggregateVersion: '1',
              occurredAt: new Date().toISOString(),
              correlationId: s.id,
              causationId: null,
              payload: { subscriptionId: s.id, storeId: s.store_id, deliveryDate: s.delivery_date },
            },
            ['notifications'],
          );
      }
    });
  }
}
