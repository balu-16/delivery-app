import http from 'k6/http';
import exec from 'k6/execution';
import { Rate, Trend, Counter } from 'k6/metrics';
const fixture = JSON.parse(open(__ENV.LOAD_FIXTURE_FILE));
const profiles = {
  local: { rate: 20, duration: '5m', seconds: 300, riders: 100 },
  smoke: { rate: 2, duration: '3s', seconds: 3, riders: 100 },
  staging: { rate: 1000, duration: '30m', seconds: 1800, riders: 5000 },
};
const p = profiles[__ENV.LOAD_PROFILE];
if (!p || !__ENV.BASE_URL || fixture.riders.length < p.riders)
  throw new Error('Profile, URL, or rider dataset missing');
const errors = new Rate('unexpected_errors'),
  latency = new Trend('gps_latency', true),
  completed = new Counter('gps_completed'),
  persisted = new Counter('gps_persisted');
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  scenarios: {
    gps: {
      executor: 'constant-arrival-rate',
      rate: p.rate,
      timeUnit: '1s',
      duration: p.duration,
      preAllocatedVUs: p.rate * 2,
      maxVUs: p.rate * 5,
    },
  },
  thresholds: {
    gps_latency: ['p(95)<=200'],
    unexpected_errors: ['rate<0.001'],
    dropped_iterations: ['count==0'],
    gps_completed: [`count>=${p.rate * p.seconds}`],
    gps_persisted: [`count>=${p.rate * p.seconds}`],
  },
};
export default function () {
  const n = exec.scenario.iterationInTest,
    rider = fixture.riders[n % p.riders],
    cycle = Math.floor(n / p.riders);
  // Move 55m per visit, forcing distance-based persistence with ~5s per rider locally.
  const point = {
    ts: new Date().toISOString(),
    lat: 12.97 + cycle * 0.0005,
    lng: 77.59,
    accuracyM: 5,
    isMock: false,
  };
  const response = http.post(
    `${__ENV.BASE_URL.replace(/\/$/, '')}/v1/rider/location`,
    JSON.stringify({ points: [point] }),
    {
      headers: { Authorization: `Bearer ${rider.token}`, 'Content-Type': 'application/json' },
      timeout: '10s',
    },
  );
  latency.add(response.timings.duration);
  completed.add(1);
  let result;
  try {
    result = response.json();
  } catch {
    result = {};
  }
  const ok =
    (response.status === 200 || response.status === 201) &&
    result.accepted === 1 &&
    result.persisted === 1;
  errors.add(!ok);
  if (result.persisted === 1) persisted.add(1);
}
export function handleSummary(data) {
  return {
    [__ENV.SUMMARY_PATH || 'gps-summary.json']: JSON.stringify(
      { profile: __ENV.LOAD_PROFILE, configured: p, metrics: data.metrics, state: data.state },
      null,
      2,
    ),
  };
}
