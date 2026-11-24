import { Injectable } from '@nestjs/common';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20, 30, 60] as const;
type Observation = { count: number; sum: number; buckets: number[] };

const CUSTOMER_ROUTES = [
  ['cart', /^\/v1\/customer\/cart$/],
  ['cart_item', /^\/v1\/customer\/cart\/items\/[^/]+$/],
  ['cart_coupon', /^\/v1\/customer\/cart\/coupon$/],
  ['checkout_quote', /^\/v1\/customer\/checkout\/quote$/],
  ['checkout_place', /^\/v1\/customer\/checkout\/place$/],
  ['checkout_status', /^\/v1\/customer\/checkout\/placement-status$/],
  ['orders', /^\/v1\/customer\/orders$/],
  ['order_detail', /^\/v1\/customer\/orders\/[^/]+$/],
  ['favorites', /^\/v1\/customer\/favorites(?:\/.*)?$/],
  ['catalog_home', /^\/v1\/customer\/catalog\/home$/],
  ['catalog_category', /^\/v1\/customer\/catalog\/categories(?:\/.*)?$/],
  ['catalog_preview', /^\/v1\/customer\/catalog\/preview$/],
  ['delivery_settings', /^\/v1\/customer\/delivery-settings$/],
  ['catalog', /^\/v1\/customer\/(?:catalog|search)(?:\/.*)?$/],
] as const;

const STAGES = [
  'ip_rate_limit',
  'token_verification',
  'principal_authorization',
  'session_auth',
  'actor_rate_limit',
  'redis',
  'db_acquire',
  'db_query',
  'db_transaction',
  'cart_write',
  'cart_write_txn',
  'cart_lock_wait',
  'idempotency_claim',
  'checkout_quote',
  'checkout_quote_txn',
  'checkout_placement_transaction',
  'checkout_post_commit',
  'rider_upload_target',
  'rider_upload_prepare',
  'rider_upload_head',
  'rider_upload_claim',
  'rider_upload_copy',
  'rider_upload_verify',
  'rider_upload_commit',
  'rider_upload_finalize',
  'rider_upload_register',
] as const;
export type MetricStage = (typeof STAGES)[number];

const IDEMPOTENCY_OUTCOMES = [
  'claimed',
  'replay',
  'rejected',
  'in_progress',
  'conflict',
  'response_expired',
] as const;
export type IdempotencyOutcome = (typeof IDEMPOTENCY_OUTCOMES)[number];

/**
 * Bounded transaction outcomes for `transactionWithRetry` (Section 3 metrics).
 * `committed` counts one successful call, `retry` counts each 40001/40P01
 * that schedules another attempt, `deadlock`/`serialization` count every
 * 40P01/40001 occurrence, and `failed` counts each call that ultimately throws.
 * Values are fixed strings; they never carry SQL text, keys, or identifiers.
 */
const TRANSACTION_OUTCOMES = ['committed', 'retry', 'deadlock', 'serialization', 'failed'] as const;
export type TransactionOutcome = (typeof TRANSACTION_OUTCOMES)[number];

/**
 * Bounded route templates for rider/store/admin. Each pattern matches a
 * fixed template name, collapsing ID segments, so labels never contain
 * customer IDs, order IDs, or other request identifiers. Patterns are
 * ordered most-specific first.
 */
const PORTAL_ROUTES = [
  ['payments_webhook', /^\/v1\/customer\/webhooks\/payments\/(?:fake|razorpay)$/],
  ['rider_onboarding', /^\/v1\/rider\/onboarding(?:\/.*)?$/],
  ['rider_tasks', /^\/v1\/rider\/tasks(?:\/.*)?$/],
  ['rider_offers', /^\/v1\/rider\/offers(?:\/.*)?$/],
  ['rider_location', /^\/v1\/rider\/(?:location|heartbeat|status)(?:\/.*)?$/],
  ['rider_notifications', /^\/v1\/rider\/notifications(?:\/.*)?$/],
  ['rider_tickets', /^\/v1\/rider\/tickets(?:\/.*)?$/],
  ['rider_earnings', /^\/v1\/rider\/(?:earnings|cash-in-hand|dashboard)(?:\/.*)?$/],
  ['rider_identity', /^\/v1\/rider\/(?:auth|me)(?:\/.*)?$/],
  ['store_auth', /^\/v1\/store\/auth(?:\/.*)?$/],
  ['store_pick_tasks', /^\/v1\/store\/pick-tasks(?:\/.*)?$/],
  ['store_inventory', /^\/v1\/store\/inventory(?:\/.*)?$/],
  ['store_orders', /^\/v1\/store\/orders(?:\/.*)?$/],
  ['store_dashboard', /^\/v1\/store\/(?:dashboard|search|status|returns)(?:\/.*)?$/],
  ['store_notifications', /^\/v1\/store\/notifications(?:\/.*)?$/],
  ['store_rider_applications', /^\/v1\/store\/rider-(?:applications|documents)(?:\/.*)?$/],
  ['admin_auth', /^\/v1\/admin\/auth(?:\/.*)?$/],
  ['admin_catalog', /^\/v1\/admin\/catalog(?:\/.*)?$/],
  ['admin_inventory', /^\/v1\/admin\/inventory(?:\/.*)?$/],
  ['admin_orders', /^\/v1\/admin\/orders(?:\/.*)?$/],
  ['admin_system', /^\/v1\/admin\/system(?:\/.*)?$/],
  ['admin_approvals', /^\/v1\/admin\/approvals(?:\/.*)?$/],
  ['admin_fraud_signals', /^\/v1\/admin\/fraud-signals(?:\/.*)?$/],
  ['admin_ops_outbox', /^\/v1\/admin\/ops\/outbox(?:\/.*)?$/],
  ['admin_wallet', /^\/v1\/admin\/wallet(?:\/.*)?$/],
] as const;

/** Bounded labels deliberately exclude URLs, identifiers, headers and request bodies. */
@Injectable()
export class HttpMetrics {
  private readonly observations = new Map<string, Observation>();
  private readonly routes = new Map<string, Observation>();
  private readonly portalRoutes = new Map<string, Observation>();
  private readonly stages = new Map<MetricStage, Observation>();
  private readonly outcomes = new Map<IdempotencyOutcome, number>();
  private readonly txOutcomes = new Map<TransactionOutcome, number>();

  private record<K>(map: Map<K, Observation>, key: K, milliseconds: number): void {
    let observation = map.get(key);
    if (!observation) {
      observation = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      map.set(key, observation);
    }
    const seconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) / 1000 : 0;
    observation.count++;
    observation.sum += seconds;
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) observation.buckets[index]!++;
    });
  }

  observe(method: string, url: string, status: number, milliseconds: number): void {
    const verb = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)
      ? method
      : 'OTHER';
    const audience = /^\/v1\/(customer|rider|store|admin)(?:\/|\?|$)/.exec(url)?.[1] ?? 'other';
    const statusClass = status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other';
    const key = `method="${verb}",audience="${audience}",status_class="${statusClass}"`;
    this.record(this.observations, key, milliseconds);
    const path = url.split('?', 1)[0] ?? '';
    const customerRoute = CUSTOMER_ROUTES.find(([, pattern]) => pattern.test(path))?.[0];
    if (customerRoute) {
      this.record(
        this.routes,
        `method="${verb}",route="${customerRoute}",status_class="${statusClass}"`,
        milliseconds,
      );
      return;
    }
    const portalRoute = PORTAL_ROUTES.find(([, pattern]) => pattern.test(path))?.[0];
    if (portalRoute)
      this.record(
        this.portalRoutes,
        `method="${verb}",audience="${audience}",route="${portalRoute}",status_class="${statusClass}"`,
        milliseconds,
      );
  }

  observeStage(stage: MetricStage, milliseconds: number): void {
    // Runtime validation keeps metric cardinality bounded even for JS callers.
    if ((STAGES as readonly string[]).includes(stage))
      this.record(this.stages, stage, milliseconds);
  }

  /** Bounded idempotency claim outcomes for cart writes and checkout placement. */
  observeOutcome(outcome: IdempotencyOutcome): void {
    if ((IDEMPOTENCY_OUTCOMES as readonly string[]).includes(outcome))
      this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1);
  }

  /** Bounded transaction retry/deadlock outcomes; see TRANSACTION_OUTCOMES. */
  observeTransactionOutcome(outcome: TransactionOutcome): void {
    if ((TRANSACTION_OUTCOMES as readonly string[]).includes(outcome))
      this.txOutcomes.set(outcome, (this.txOutcomes.get(outcome) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      '# HELP delivery_process_up Process is running',
      '# TYPE delivery_process_up gauge',
      'delivery_process_up 1',
      '# HELP delivery_http_request_duration_seconds HTTP request duration by audience and status class',
      '# TYPE delivery_http_request_duration_seconds histogram',
    ];
    for (const [labels, observation] of this.observations) {
      BUCKETS.forEach((bound, index) =>
        lines.push(
          `delivery_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${observation.buckets[index]}`,
        ),
      );
      lines.push(
        `delivery_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${observation.count}`,
        `delivery_http_request_duration_seconds_sum{${labels}} ${observation.sum}`,
        `delivery_http_request_duration_seconds_count{${labels}} ${observation.count}`,
      );
    }
    lines.push(
      '# HELP delivery_customer_route_duration_seconds Customer route duration by bounded route and status class',
      '# TYPE delivery_customer_route_duration_seconds histogram',
    );
    for (const [labels, observation] of this.routes) {
      BUCKETS.forEach((bound, index) =>
        lines.push(
          `delivery_customer_route_duration_seconds_bucket{${labels},le="${bound}"} ${observation.buckets[index]}`,
        ),
      );
      lines.push(
        `delivery_customer_route_duration_seconds_bucket{${labels},le="+Inf"} ${observation.count}`,
        `delivery_customer_route_duration_seconds_sum{${labels}} ${observation.sum}`,
        `delivery_customer_route_duration_seconds_count{${labels}} ${observation.count}`,
      );
    }
    lines.push(
      '# HELP delivery_dependency_stage_duration_seconds Duration of bounded application and dependency stages',
      '# TYPE delivery_dependency_stage_duration_seconds histogram',
    );
    for (const [stage, observation] of this.stages) {
      const labels = `stage="${stage}"`;
      BUCKETS.forEach((bound, index) =>
        lines.push(
          `delivery_dependency_stage_duration_seconds_bucket{${labels},le="${bound}"} ${observation.buckets[index]}`,
        ),
      );
      lines.push(
        `delivery_dependency_stage_duration_seconds_bucket{${labels},le="+Inf"} ${observation.count}`,
        `delivery_dependency_stage_duration_seconds_sum{${labels}} ${observation.sum}`,
        `delivery_dependency_stage_duration_seconds_count{${labels}} ${observation.count}`,
      );
    }
    lines.push(
      '# HELP delivery_portal_route_duration_seconds Portal route duration by bounded route and status class',
      '# TYPE delivery_portal_route_duration_seconds histogram',
    );
    for (const [labels, observation] of this.portalRoutes) {
      BUCKETS.forEach((bound, index) =>
        lines.push(
          `delivery_portal_route_duration_seconds_bucket{${labels},le="${bound}"} ${observation.buckets[index]}`,
        ),
      );
      lines.push(
        `delivery_portal_route_duration_seconds_bucket{${labels},le="+Inf"} ${observation.count}`,
        `delivery_portal_route_duration_seconds_sum{${labels}} ${observation.sum}`,
        `delivery_portal_route_duration_seconds_count{${labels}} ${observation.count}`,
      );
    }
    lines.push(
      '# HELP delivery_idempotency_outcomes_total Idempotency claim outcomes by bounded result',
      '# TYPE delivery_idempotency_outcomes_total counter',
    );
    for (const [outcome, count] of this.outcomes)
      lines.push(`delivery_idempotency_outcomes_total{outcome="${outcome}"} ${count}`);
    lines.push(
      '# HELP delivery_db_transaction_outcomes_total Database transaction outcomes by bounded result',
      '# TYPE delivery_db_transaction_outcomes_total counter',
    );
    for (const [outcome, count] of this.txOutcomes)
      lines.push(`delivery_db_transaction_outcomes_total{outcome="${outcome}"} ${count}`);
    return `${lines.join('\n')}\n`;
  }
}
