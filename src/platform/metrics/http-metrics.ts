import { Injectable } from '@nestjs/common';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
type Observation = { count: number; sum: number; buckets: number[] };

/** Bounded labels deliberately exclude URLs, identifiers, headers and request bodies. */
@Injectable()
export class HttpMetrics {
  private readonly observations = new Map<string, Observation>();

  observe(method: string, url: string, status: number, milliseconds: number): void {
    const verb = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)
      ? method
      : 'OTHER';
    const audience = /^\/v1\/(customer|rider|store|admin)(?:\/|\?|$)/.exec(url)?.[1] ?? 'other';
    const statusClass = status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other';
    const key = `method="${verb}",audience="${audience}",status_class="${statusClass}"`;
    let observation = this.observations.get(key);
    if (!observation) {
      observation = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      this.observations.set(key, observation);
    }
    const seconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) / 1000 : 0;
    observation.count++;
    observation.sum += seconds;
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) observation.buckets[index]!++;
    });
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
    return `${lines.join('\n')}\n`;
  }
}
