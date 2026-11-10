import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

// Fixed acceptance profiles; smoke is intentionally named and cannot be mistaken for acceptance.
const profiles = {
  local: { duration: '5m', catalog: 20, search: 10, seconds: 300 },
  staging: { duration: '5m', catalog: 200, search: 100, seconds: 300 },
  smoke: { duration: '3s', catalog: 2, search: 1, seconds: 3 },
};
const profile = profiles[__ENV.LOAD_PROFILE];
if (!profile) throw new Error('LOAD_PROFILE must be local, staging, or smoke');
if (!__ENV.BASE_URL || !__ENV.CUSTOMER_TOKEN || !__ENV.ADDRESS_ID)
  throw new Error('BASE_URL, CUSTOMER_TOKEN, and ADDRESS_ID are required');
const unexpected = new Rate('unexpected_errors');
const catalogLatency = new Trend('catalog_latency', true);
const searchLatency = new Trend('search_latency', true);
const completedCatalog = new Counter('catalog_completed');
const completedSearch = new Counter('search_completed');
const success = new Counter('successful_responses');
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  scenarios: {
    catalog: {
      executor: 'constant-arrival-rate',
      exec: 'catalog',
      rate: profile.catalog,
      timeUnit: '1s',
      duration: profile.duration,
      preAllocatedVUs: profile.catalog * 2,
      maxVUs: profile.catalog * 10,
    },
    search: {
      executor: 'constant-arrival-rate',
      exec: 'search',
      rate: profile.search,
      timeUnit: '1s',
      duration: profile.duration,
      preAllocatedVUs: profile.search * 2,
      maxVUs: profile.search * 10,
    },
  },
  thresholds: {
    catalog_latency: ['p(95)<=300'],
    search_latency: ['p(95)<=500'],
    unexpected_errors: ['rate<0.001'],
    dropped_iterations: ['count==0'],
    catalog_completed: [`count>=${profile.catalog * profile.seconds}`],
    search_completed: [`count>=${profile.search * profile.seconds}`],
  },
};
function request(path, latency, count) {
  const response = http.get(`${__ENV.BASE_URL.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${__ENV.CUSTOMER_TOKEN}` },
    timeout: '10s',
    tags: { endpoint: path.split('?')[0] },
  });
  latency.add(response.timings.duration);
  count.add(1);
  const ok = response.status === 200;
  unexpected.add(!ok);
  if (ok) success.add(1);
}
export function catalog() {
  request(
    `/v1/customer/catalog/home?addressId=${encodeURIComponent(__ENV.ADDRESS_ID)}`,
    catalogLatency,
    completedCatalog,
  );
}
export function search() {
  request(
    `/v1/customer/search?q=milk&addressId=${encodeURIComponent(__ENV.ADDRESS_ID)}`,
    searchLatency,
    completedSearch,
  );
}
export function handleSummary(data) {
  return {
    [__ENV.SUMMARY_PATH || 'catalog-summary.json']: JSON.stringify(
      {
        profile: __ENV.LOAD_PROFILE,
        configured: profile,
        metrics: data.metrics,
        state: data.state,
      },
      null,
      2,
    ),
  };
}
