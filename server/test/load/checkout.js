import http from 'k6/http';
import exec from 'k6/execution';
import { Rate, Trend, Counter } from 'k6/metrics';
const fixture = JSON.parse(open(__ENV.LOAD_FIXTURE_FILE));
const profiles = {
  local: { rate: 2, duration: '5m', seconds: 300 },
  smoke: { rate: 1, duration: '3s', seconds: 3 },
  diagnostic: { rate: 10, duration: '15s', seconds: 15 },
  staging: { rate: 20, duration: '15m', seconds: 900 },
};
const p = profiles[__ENV.LOAD_PROFILE];
const offset = Number(__ENV.CHECKOUT_OFFSET || '0');
if (!Number.isSafeInteger(offset) || offset < 0)
  throw new Error('CHECKOUT_OFFSET must be a nonnegative integer');
if (
  !p ||
  !__ENV.BASE_URL ||
  fixture.customers.length < offset + p.rate * p.seconds + 10 ||
  fixture.variants.length < 200
)
  throw new Error('Profile, URL, or dataset insufficient');
if (!['distributed', 'hot'].includes(__ENV.CHECKOUT_MODE))
  throw new Error('CHECKOUT_MODE must be distributed or hot');
const errors = new Rate('unexpected_errors'),
  latency = new Trend('checkout_latency', true),
  completed = new Counter('checkout_completed'),
  confirmed = new Counter('checkout_confirmed'),
  failureCodes = new Counter('checkout_failure_codes');
let loggedFailure = false;
function recordFailure(step, response) {
  let code;
  try {
    code = response.json().code;
  } catch {
    // Missing or invalid problem JSON has no safe code.
  }
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) code = 'UNKNOWN';
  failureCodes.add(1, { step, status: String(response.status), code });
  if (!loggedFailure) {
    console.warn(`checkout failure step=${step} status=${response.status} code=${code}`);
    loggedFailure = true;
  }
}
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  scenarios: {
    checkout: {
      executor: 'constant-arrival-rate',
      rate: p.rate,
      timeUnit: '1s',
      duration: p.duration,
      preAllocatedVUs: p.rate * 4,
      maxVUs: p.rate * 10,
    },
  },
  thresholds: {
    checkout_latency: ['p(95)<=1000'],
    unexpected_errors: ['rate<0.001'],
    dropped_iterations: ['count==0'],
    checkout_completed: [`count>=${p.rate * p.seconds}`],
    checkout_confirmed: [`count>=${p.rate * p.seconds}`],
  },
};
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
export default function () {
  const n = exec.scenario.iterationInTest,
    customer = fixture.customers[offset + n],
    variant = fixture.variants[__ENV.CHECKOUT_MODE === 'hot' ? 0 : n % fixture.variants.length];
  const base = __ENV.BASE_URL.replace(/\/$/, ''),
    headers = {
      Authorization: `Bearer ${customer.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': uuid(),
    };
  const begin = Date.now();
  const cart = http.put(
    `${base}/v1/customer/cart/items/${variant}`,
    JSON.stringify({ quantity: '1', version: 1, addressId: customer.addressId }),
    { headers, timeout: '10s' },
  );
  if (cart.status !== 200 && cart.status !== 201) {
    recordFailure('cart', cart);
    errors.add(true);
    completed.add(1);
    latency.add(Date.now() - begin);
    return;
  }
  const quote = http.post(
    `${base}/v1/customer/checkout/quote`,
    JSON.stringify({ addressId: customer.addressId }),
    { headers, timeout: '10s' },
  );
  let q;
  try {
    q = quote.json();
  } catch {
    q = {};
  }
  if (
    quote.status !== 200 ||
    !q.quote?.quoteId ||
    !q.intentId ||
    Number(q.quote.wallet?.cashPaise ?? 0) <= 0 ||
    q.quote.amountDuePaise !== '0'
  ) {
    recordFailure('quote', quote);
    errors.add(true);
    completed.add(1);
    latency.add(Date.now() - begin);
    return;
  }
  headers['Idempotency-Key'] = uuid();
  const place = http.post(
    `${base}/v1/customer/checkout/place`,
    JSON.stringify({ quoteId: q.quote.quoteId, intentId: q.intentId, method: 'GATEWAY' }),
    { headers, timeout: '10s' },
  );
  let result;
  try {
    result = place.json();
  } catch {
    result = {};
  }
  const ok =
    (place.status === 200 || place.status === 201) &&
    result.confirmation === 'CONFIRMED' &&
    Number(result.order?.walletCashPaise ?? 0) > 0;
  latency.add(Date.now() - begin);
  completed.add(1);
  errors.add(!ok);
  if (!ok) recordFailure('place', place);
  if (ok) confirmed.add(1);
}
export function handleSummary(data) {
  return {
    [__ENV.SUMMARY_PATH || 'checkout-summary.json']: JSON.stringify(
      {
        profile: __ENV.LOAD_PROFILE,
        mode: __ENV.CHECKOUT_MODE,
        offset,
        configured: p,
        metrics: data.metrics,
        state: data.state,
      },
      null,
      2,
    ),
  };
}
