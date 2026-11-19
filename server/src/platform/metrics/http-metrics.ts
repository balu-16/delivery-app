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
  'actor_rate_limit',
  'db_acquire',
  'db_query',
  'cart_write',
  'cart_write_txn',
  'cart_lock_wait',
  'idempotency_claim',
  'checkout_quote',
  'checkout_quote_txn',
  'checkout_placement_transaction',
  'checkout_post_commit',
] as const;
export type MetricStage = (typeof STAGES)[number];

const IDEMPOTENCY_OUTCOMES = [
  'claimed',
  'replay',
  'in_progress',
  'conflict',
  'response_expired',
] as const;
export type IdempotencyOutcome = (typeof IDEMPOTENCY_OUTCOMES)[number];

/** Bounded labels deliberately exclude URLs, identifiers, headers and request bodies. */
@Injectable()
export class HttpMetrics {
  private readonly observations = new Map<string, Observation>();
  private readonly routes = new Map<string, Observation>();
  private readonly stages = new Map<MetricStage, Observation>();
  private readonly outcomes = new Map<IdempotencyOutcome, number>();

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
    const route = CUSTOMER_ROUTES.find(([, pattern]) => pattern.test(path))?.[0];
    if (route)
      this.record(
        this.routes,
        `method="${verb}",route="${route}",status_class="${statusClass}"`,
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
      '# HELP delivery_idempotency_outcomes_total Idempotency claim outcomes by bounded result',
      '# TYPE delivery_idempotency_outcomes_total counter',
    );
    for (const [outcome, count] of this.outcomes)
      lines.push(`delivery_idempotency_outcomes_total{outcome="${outcome}"} ${count}`);
    return `${lines.join('\n')}\n`;
  }
}
