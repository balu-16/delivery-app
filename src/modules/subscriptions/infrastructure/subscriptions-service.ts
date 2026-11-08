import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { OrderOperations } from '../../orders/contracts/orders.js';
import { decodePage, pageResult } from '../domain/page.js';
import type { SubscriptionChanges } from '../contracts/subscriptions.js';
import type { CheckoutOperations } from '../../checkout/contracts/checkout.js';
import {
  addDays,
  firstEditableDate,
  nextOccurrence,
  occursOn,
  validateFrequency,
  type FrequencyRule,
} from '../domain/schedule.js';

export interface CreateSubscription {
  variantId: string;
  quantity: string;
  frequencyRule: FrequencyRule;
  startDate: string;
  endDate?: string;
  slotId: string;
  addressId: string;
}
interface SubscriptionRow {
  id: string;
  user_id: string;
  store_id: string;
  start_date: string;
  end_date: string | null;
  status: string;
  quantity: string;
  frequency_rule: FrequencyRule;
  slot_id: string;
  address_id: string;
  next_delivery_date: string | null;
}
export class SubscriptionsService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly orders: OrderOperations,
    private readonly checkout: CheckoutOperations,
  ) {}
  private run<T>(
    outer: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return outer ? fn(outer) : transactionWithRetry(this.db, fn);
  }
  private async lock(tx: TransactionContext, userId: string, id: string): Promise<SubscriptionRow> {
    await lockActiveCustomer(userId, tx);
    const found =
      await sql<SubscriptionRow>`SELECT s.id::text,s.user_id::text,s.store_id::text,s.start_date::text,s.end_date::text,s.status,
      v.quantity::text,v.frequency_rule,v.slot_id::text,COALESCE(v.address_id,s.address_id)::text AS address_id,s.next_delivery_date::text FROM subscriptions s JOIN LATERAL (SELECT * FROM subscription_schedule_versions sv WHERE sv.subscription_id=s.id ORDER BY effective_from DESC LIMIT 1) v ON true WHERE s.id=${id}::uuid AND s.user_id=${userId}::uuid FOR UPDATE OF s`.execute(
        tx,
      );
    if (!found.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    return found.rows[0];
  }
  private async editable(tx: TransactionContext): Promise<string> {
    const now = await databaseTimeAfterLock(tx);
    return firstEditableDate(now, await this.config.get('subscriptionCutoffTime', tx));
  }
  async create(userId: string, input: CreateSubscription, outer?: TransactionContext) {
    validateFrequency(input.frequencyRule);
    addDays(input.startDate, 0);
    if (input.endDate) addDays(input.endDate, 0);
    if (
      !/^[1-9]\d{0,18}$/.test(input.quantity) ||
      (input.endDate && input.endDate < input.startDate)
    )
      throw new Error('INVALID_INPUT');
    return this.run(outer, async (tx) => {
      await lockActiveCustomer(userId, tx);
      const flags = await sql<{
        key: string;
        enabled: boolean;
      }>`SELECT key,enabled FROM feature_flags WHERE key IN ('wallet_enabled','subscriptions_enabled') FOR SHARE`.execute(
        tx,
      );
      if (
        !['wallet_enabled', 'subscriptions_enabled'].every((key) =>
          flags.rows.some((row) => row.key === key && row.enabled),
        )
      )
        throw new Error('SUBSCRIPTIONS_DISABLED');
      const selected = await sql<{
        plan_id: string;
        store_id: string;
        slot_start: string;
      }>`SELECT p.id::text AS plan_id,sl.store_id::text,sl.start_time::text AS slot_start
        FROM subscription_plans p JOIN subscription_slots sl ON sl.id=${input.slotId}::uuid AND sl.active
        JOIN addresses a ON a.id=${input.addressId}::uuid AND a.user_id=${userId}::uuid AND a.deleted_at IS NULL
        JOIN zones z ON z.store_id=sl.store_id AND z.active AND ST_Covers(z.polygon,a.point::geometry)
        WHERE p.variant_id=${input.variantId}::uuid AND p.active LIMIT 1 FOR SHARE OF p,sl,a,z`.execute(
        tx,
      );
      const choice = selected.rows[0];
      if (!choice) throw new Error('ADDRESS_NOT_SERVICEABLE');
      const retryDeadline = await this.config.get('subscriptionGraceDeadlineTime', tx);
      const dispatchLead = await this.config.get('subscriptionDispatchLeadMinutes', tx);
      const [h, m] = choice.slot_start.split(':').map(Number);
      const [dh, dm] = retryDeadline.split(':').map(Number);
      if (h! * 60 + m! - dispatchLead <= dh! * 60 + dm!) throw new Error('INVALID_SLOT_TIMING');
      const effective = await this.editable(tx);
      const next = nextOccurrence(input.startDate, effective, input.frequencyRule, input.endDate);
      if (!next) throw new Error('NO_ELIGIBLE_DELIVERY');
      const id = uuidV7();
      await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${id}::uuid,${userId}::uuid,${choice.plan_id}::uuid,${choice.store_id}::uuid,${input.addressId}::uuid,${input.startDate}::date,${input.endDate ?? null}::date,${next}::date)`.execute(
        tx,
      );
      await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id,address_id) VALUES(${uuidV7()}::uuid,${id}::uuid,${input.startDate}::date,${input.quantity}::bigint,${JSON.stringify(input.frequencyRule)}::jsonb,${input.slotId}::uuid,${input.addressId}::uuid)`.execute(
        tx,
      );
      return { id, nextDeliveryDate: next, effectiveFrom: effective };
    });
  }
  async list(userId: string, limit?: number, cursor?: string) {
    const scope = `customer:${userId}`,
      page = decodePage(cursor, scope, limit);
    if (page.after && !/^[0-9a-f-]{36}$/i.test(page.after)) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
    }>`SELECT s.*,p.variant_id FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.user_id=${userId}::uuid AND (${page.after}::uuid IS NULL OR s.id>${page.after}::uuid) ORDER BY s.id LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    return pageResult(rows.rows, page.limit, scope, (r) => r.id);
  }
  async get(userId: string, id: string) {
    const result =
      await sql`SELECT s.*,p.variant_id FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.user_id=${userId}::uuid AND s.id=${id}::uuid`.execute(
        this.db,
      );
    if (!result.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    return result.rows[0];
  }
  async upcoming(userId: string, id: string, from: string, to: string, limit = 100) {
    addDays(from, 0);
    addDays(to, 0);
    if (
      from > to ||
      to > addDays(from, 3660) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('INVALID_DATE_RANGE');
    await this.get(userId, id);
    const rows = await sql<{
      date: string;
      start_date: string;
      end_date: string | null;
      status: string;
      store_id: string;
      address_id: string;
      variant_id: string;
      quantity: string;
      frequency_rule: FrequencyRule;
      slot_start: string;
      slot_end: string;
      occurrence_state: string | null;
      reason: string | null;
      order_id: string | null;
      amount: string | null;
      skipped: boolean;
      paused: boolean;
      holiday: boolean;
    }>`SELECT d.day::date::text AS date,s.start_date::text,s.end_date::text,s.status,s.store_id::text,COALESCE(v.address_id,s.address_id)::text AS address_id,p.variant_id::text,v.quantity::text,v.frequency_rule,sl.start_time::text AS slot_start,sl.end_time::text AS slot_end,o.state AS occurrence_state,o.reason,o.order_id::text,orders.total_paise::text AS amount,
    EXISTS(SELECT 1 FROM subscription_skips sk WHERE sk.subscription_id=s.id AND sk.delivery_date=d.day::date) AS skipped,
    EXISTS(SELECT 1 FROM subscription_pauses pa WHERE pa.subscription_id=s.id AND d.day::date BETWEEN pa.starts_on AND pa.ends_on) AS paused,
    EXISTS(SELECT 1 FROM subscription_holidays h WHERE h.store_id=s.store_id AND h.holiday_date=d.day::date) AS holiday
    FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id CROSS JOIN generate_series(${from}::date,${to}::date,interval '1 day') d(day)
    JOIN LATERAL (SELECT * FROM subscription_schedule_versions sv WHERE sv.subscription_id=s.id AND sv.effective_from<=d.day::date ORDER BY effective_from DESC LIMIT 1) v ON true
    JOIN subscription_slots sl ON sl.id=v.slot_id LEFT JOIN subscription_occurrences o ON o.subscription_id=s.id AND o.delivery_date=d.day::date
    LEFT JOIN orders ON orders.id=o.order_id WHERE s.id=${id}::uuid AND s.user_id=${userId}::uuid ORDER BY d.day`.execute(
      this.db,
    );
    const output = [];
    for (const r of rows.rows) {
      if (output.length >= limit) break;
      if ((r.end_date && r.date > r.end_date) || !occursOn(r.start_date, r.date, r.frequency_rule))
        continue;
      let amount = r.amount;
      if (amount === null && r.status === 'ACTIVE' && !r.skipped && !r.paused && !r.holiday) {
        try {
          const estimate = await this.db.transaction().execute((tx) =>
            this.checkout.priceScheduled(
              {
                userId,
                subscriptionId: id,
                deliveryDate: r.date,
                storeId: r.store_id,
                addressId: r.address_id,
                variantId: r.variant_id,
                quantity: r.quantity,
                slotStart: new Date(`${r.date}T${r.slot_start}+05:30`).toISOString(),
                slotEnd: new Date(`${r.date}T${r.slot_end}+05:30`).toISOString(),
              },
              tx,
            ),
          );
          amount = estimate.totalPaise;
        } catch {
          /* unavailable estimates are explicit nulls */
        }
      }
      output.push({
        date: r.date,
        status:
          r.occurrence_state ??
          (r.skipped
            ? 'SKIPPED'
            : r.paused
              ? 'PAUSED'
              : r.holiday
                ? 'HOLIDAY'
                : r.status === 'ACTIVE'
                  ? 'SCHEDULED'
                  : r.status),
        reason: r.reason,
        orderId: r.order_id,
        amountPaise: amount,
        estimated: r.order_id === null,
      });
    }
    return output;
  }
  async calendar(userId: string, month: string, limit?: number, cursor?: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('INVALID_DATE');
    const from = `${month}-01`,
      to = addDays(
        new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
          .toISOString()
          .slice(0, 10),
        -1,
      );
    const scope = `calendar:${userId}:${month}`,
      page = decodePage(cursor, scope, limit);
    if (page.after && !/^[0-9a-f-]{36}$/i.test(page.after)) throw new Error('INVALID_PAGE');
    const subscriptions = await sql<{
      id: string;
    }>`SELECT id::text FROM subscriptions WHERE user_id=${userId}::uuid AND (${page.after}::uuid IS NULL OR id>${page.after}::uuid) ORDER BY id LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    const result = [];
    for (const s of subscriptions.rows.slice(0, page.limit))
      result.push({
        subscriptionId: s.id,
        deliveries: await this.upcoming(userId, s.id, from, to),
      });
    return {
      items: result,
      nextCursor:
        subscriptions.rows.length > page.limit
          ? Buffer.from(
              JSON.stringify({ scope, after: subscriptions.rows[page.limit - 1]!.id }),
            ).toString('base64url')
          : null,
    };
  }

  async quantity(userId: string, id: string, quantity: string, outer?: TransactionContext) {
    return this.change(userId, id, { quantity }, outer);
  }
  async change(userId: string, id: string, input: SubscriptionChanges, outer?: TransactionContext) {
    if (
      !Object.keys(input).length ||
      (input.quantity !== undefined && !/^[1-9]\d{0,18}$/.test(input.quantity))
    )
      throw new Error('INVALID_INPUT');
    if (input.frequencyRule) validateFrequency(input.frequencyRule);
    return this.run(outer, async (tx) => {
      const s = await this.lock(tx, userId, id);
      if (s.status !== 'ACTIVE' && s.status !== 'PAUSED')
        throw new Error('SUBSCRIPTION_STATE_INVALID');
      const effective = await this.editable(tx),
        address = input.addressId ?? s.address_id,
        slot = input.slotId ?? s.slot_id,
        rule = input.frequencyRule ?? s.frequency_rule,
        quantity = input.quantity ?? s.quantity;
      const valid =
        await sql`SELECT 1 FROM addresses a JOIN zones z ON z.store_id=${s.store_id}::uuid AND z.active AND ST_Covers(z.polygon,a.point::geometry) JOIN subscription_slots sl ON sl.id=${slot}::uuid AND sl.store_id=z.store_id AND sl.active JOIN subscription_plans p ON p.id=(SELECT plan_id FROM subscriptions WHERE id=${id}::uuid) AND p.active WHERE a.id=${address}::uuid AND a.user_id=${userId}::uuid AND a.deleted_at IS NULL FOR SHARE OF a,z,sl,p`.execute(
          tx,
        );
      if (!valid.rows.length) throw new Error('ADDRESS_NOT_SERVICEABLE');
      await this.compensate(tx, s, effective, '9999-12-31');
      await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id,address_id) VALUES(${uuidV7()}::uuid,${id}::uuid,${effective}::date,${quantity}::bigint,${JSON.stringify(rule)}::jsonb,${slot}::uuid,${address}::uuid) ON CONFLICT(subscription_id,effective_from) DO UPDATE SET quantity=EXCLUDED.quantity,frequency_rule=EXCLUDED.frequency_rule,slot_id=EXCLUDED.slot_id,address_id=EXCLUDED.address_id`.execute(
        tx,
      );
      if (!s.next_delivery_date || s.next_delivery_date >= effective) {
        const next = nextOccurrence(s.start_date, effective, rule, s.end_date);
        await sql`UPDATE subscriptions SET next_delivery_date=${next}::date,forecast_checked_at=NULL WHERE id=${id}::uuid`.execute(
          tx,
        );
      }
      return { effectiveFrom: effective };
    });
  }
  async skip(userId: string, id: string, date: string, remove = false, outer?: TransactionContext) {
    addDays(date, 0);
    return this.run(outer, async (tx) => {
      const s = await this.lock(tx, userId, id);
      const effective = await this.editable(tx);
      if (date < effective) throw new Error('CUTOFF_PASSED');
      if (s.status !== 'ACTIVE' && s.status !== 'PAUSED')
        throw new Error('SUBSCRIPTION_STATE_INVALID');
      if (!occursOn(s.start_date, date, s.frequency_rule) || (s.end_date && date > s.end_date))
        throw new Error('INVALID_DELIVERY_DATE');
      if (remove)
        await sql`DELETE FROM subscription_skips WHERE subscription_id=${id}::uuid AND delivery_date=${date}::date`.execute(
          tx,
        );
      else {
        await this.compensate(tx, s, date, date);
        await sql`INSERT INTO subscription_skips(subscription_id,delivery_date) VALUES(${id}::uuid,${date}::date) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
      }
      return { date };
    });
  }
  private async compensate(tx: TransactionContext, s: SubscriptionRow, from: string, to: string) {
    const orders = await sql<{
      order_id: string;
    }>`SELECT order_id::text FROM subscription_occurrences WHERE subscription_id=${s.id}::uuid AND delivery_date BETWEEN ${from}::date AND ${to}::date AND state='ORDERED' ORDER BY order_id`.execute(
      tx,
    );
    for (const o of orders.rows) {
      await this.orders.cancel(
        o.order_id,
        { type: 'CUSTOMER', id: s.user_id },
        'SUBSCRIPTION_CHANGE',
        { tx },
      );
      await sql`UPDATE subscription_occurrences SET fulfillment_outcome='CANCELLED',updated_at=clock_timestamp() WHERE order_id=${o.order_id}::uuid`.execute(
        tx,
      );
    }
  }
  async pause(userId: string, id: string, from: string, to: string, outer?: TransactionContext) {
    addDays(from, 0);
    addDays(to, 0);
    if (from > to) throw new Error('INVALID_INPUT');
    return this.run(outer, async (tx) => {
      const s = await this.lock(tx, userId, id);
      if (s.status !== 'ACTIVE') throw new Error('SUBSCRIPTION_STATE_INVALID');
      const effective = await this.editable(tx);
      const first = from < effective ? effective : from;
      const max = await this.config.get('subscriptionMaxPauseDays', tx);
      if (first > to || to >= addDays(first, max)) throw new Error('INVALID_PAUSE');
      await this.compensate(tx, s, first, to);
      await sql`INSERT INTO subscription_pauses(id,subscription_id,starts_on,ends_on) VALUES(${uuidV7()}::uuid,${id}::uuid,${first}::date,${to}::date)`.execute(
        tx,
      );
      return { effectiveFrom: first, to };
    });
  }
  async resume(userId: string, id: string, outer?: TransactionContext) {
    return this.run(outer, async (tx) => {
      const s = await this.lock(tx, userId, id);
      if (s.status !== 'PAUSED' && s.status !== 'ACTIVE')
        throw new Error('SUBSCRIPTION_STATE_INVALID');
      const flags = await sql<{
        key: string;
        enabled: boolean;
      }>`SELECT key,enabled FROM feature_flags WHERE key IN ('wallet_enabled','subscriptions_enabled') FOR SHARE`.execute(
        tx,
      );
      if (
        !['wallet_enabled', 'subscriptions_enabled'].every((key) =>
          flags.rows.some((row) => row.key === key && row.enabled),
        )
      )
        throw new Error('SUBSCRIPTIONS_DISABLED');
      const address =
        await sql`SELECT 1 FROM subscriptions s JOIN addresses a ON a.id=${s.address_id}::uuid AND a.user_id=s.user_id AND a.deleted_at IS NULL JOIN zones z ON z.store_id=s.store_id AND z.active AND ST_Covers(z.polygon,a.point::geometry) JOIN subscription_plans p ON p.id=s.plan_id AND p.active JOIN subscription_slots sl ON sl.id=${s.slot_id}::uuid AND sl.store_id=s.store_id AND sl.active WHERE s.id=${id}::uuid FOR SHARE OF a,z,p,sl`.execute(
          tx,
        );
      if (!address.rows.length) throw new Error('ADDRESS_NOT_SERVICEABLE');
      const effective = await this.editable(tx);
      await sql`UPDATE subscription_pauses SET ends_on=${addDays(effective, -1)}::date WHERE subscription_id=${id}::uuid AND starts_on<${effective}::date AND ends_on>=${effective}::date`.execute(
        tx,
      );
      await sql`DELETE FROM subscription_pauses WHERE subscription_id=${id}::uuid AND starts_on>=${effective}::date`.execute(
        tx,
      );
      const next = nextOccurrence(s.start_date, effective, s.frequency_rule, s.end_date);
      if (!next) throw new Error('NO_ELIGIBLE_DELIVERY');
      await sql`UPDATE subscriptions SET status='ACTIVE',failure_streak=0,next_delivery_date=${next}::date,updated_at=clock_timestamp() WHERE id=${id}::uuid`.execute(
        tx,
      );
      return { effectiveFrom: effective };
    });
  }
  async cancel(userId: string, id: string, outer?: TransactionContext) {
    return this.run(outer, async (tx) => {
      const s = await this.lock(tx, userId, id);
      if (s.status === 'CANCELLED') return { status: 'CANCELLED' };
      if (s.status === 'COMPLETED') throw new Error('SUBSCRIPTION_STATE_INVALID');
      const effective = await this.editable(tx);
      await this.compensate(tx, s, effective, '9999-12-31');
      await sql`UPDATE subscriptions SET status='CANCELLED',next_delivery_date=NULL,updated_at=clock_timestamp() WHERE id=${id}::uuid`.execute(
        tx,
      );
      return { status: 'CANCELLED', effectiveFrom: effective };
    });
  }
}
