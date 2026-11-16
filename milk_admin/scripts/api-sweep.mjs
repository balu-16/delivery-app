// API conformance sweep: replays every call the admin portal makes against the
// local backend and reports non-2xx with the problem+json code. Credentials
// come from env (ADMIN_EMAIL / ADMIN_PASSWORD) — never stored in the repo.
// Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... BASE_URL=http://localhost:13080 node scripts/api-sweep.mjs

const BASE = process.env.BASE_URL ?? 'http://localhost:13080'
const email = process.env.ADMIN_EMAIL
const password = process.env.ADMIN_PASSWORD
if (!email || !password) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment')
  process.exit(1)
}

const jar = new Map()
async function call(method, path, body) {
  const headers = { 'content-type': 'application/json' }
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    jar.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  let code = null
  try {
    code = (await res.json())?.code ?? null
  } catch { /* html or empty */ }
  return { status: res.status, code }
}

const results = []
async function check(label, method, path, body, expectStatus) {
  const r = await call(method, path, body)
  const ok = expectStatus ? r.status === expectStatus : r.status >= 200 && r.status < 300
  results.push({ label, method, path, ...r, ok, expectStatus })
  return r
}

const dateOnly = (d) => d.toISOString().slice(0, 10)
const today = new Date()
const from30 = dateOnly(new Date(today.getTime() - 29 * 86400000))

// ── login ────────────────────────────────────────────────────────────────────
const login = await call('POST', '/v1/admin/auth/login', { email, password })
console.log(`login: ${login.status} ${login.code ?? ''}`)
if (login.status !== 200) process.exit(1)
await check('auth session', 'GET', '/v1/admin/auth/session')

// ── dashboard + shared reads ─────────────────────────────────────────────────
await check('dashboard (date-only)', 'GET', `/v1/admin/dashboard?from=${from30}&to=${dateOnly(today)}`)
await check('search', 'GET', '/v1/admin/search?q=milk')
await check('fleet', 'GET', '/v1/admin/delivery/fleet')

// ── stores ───────────────────────────────────────────────────────────────────
const le = await check('legal-entities', 'GET', '/v1/admin/legal-entities?limit=100')
await check('cities', 'GET', '/v1/admin/cities?limit=100')
const stores = await check('stores', 'GET', '/v1/admin/stores?limit=100')
await check('zones', 'GET', '/v1/admin/zones?limit=100')

// ── catalog ──────────────────────────────────────────────────────────────────
await check('categories', 'GET', '/v1/admin/catalog/categories?limit=100')
await check('brands', 'GET', '/v1/admin/catalog/brands?limit=100')
const products = await check('products', 'GET', '/v1/admin/catalog/products?limit=50')
await check('variants (limit 100)', 'GET', '/v1/admin/catalog/variants?limit=100')
await check('variants rejects limit > 100', 'GET', '/v1/admin/catalog/variants?limit=200', undefined, 400)
await check('synonyms', 'GET', '/v1/admin/catalog/synonyms?limit=100')
const firstProduct = (await fetch(BASE + '/v1/admin/catalog/products?limit=1', { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } }).then((r) => r.json()))?.items?.[0]
if (firstProduct) {
  await check('product detail', 'GET', `/v1/admin/catalog/products/${firstProduct.id}`)
  await check('product variants (productId filter)', 'GET', `/v1/admin/catalog/variants?productId=${firstProduct.id}&limit=100`)
}

// ── inventory ────────────────────────────────────────────────────────────────
const storeId = (await fetch(BASE + '/v1/admin/stores?limit=1', { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } }).then((r) => r.json()))?.items?.[0]?.id
if (storeId) {
  await check('inventory report', 'GET', `/v1/admin/inventory/report?storeId=${storeId}&limit=50`)
  await check('inventory ledger', 'GET', `/v1/admin/inventory/ledger?storeId=${storeId}&limit=50`)
}
await check('inventory summary', 'GET', '/v1/admin/inventory/summary?limit=50')
await check('shelf-life', 'GET', '/v1/admin/inventory/shelf-life?limit=50')

// ── orders ───────────────────────────────────────────────────────────────────
const orders = await check('orders list', 'GET', '/v1/admin/orders?limit=10')
const orderPage = await fetch(BASE + '/v1/admin/orders?limit=1', { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } }).then((r) => r.json())
const orderId = orderPage?.items?.[0]?.id
if (orderId) {
  await check('order detail', 'GET', `/v1/admin/orders/${orderId}`)
  await check('order timeline', 'GET', `/v1/admin/orders/${orderId}/timeline`)
  await check('order payments', 'GET', `/v1/admin/orders/${orderId}/payments`)
  await check('rider candidates', 'GET', `/v1/admin/orders/${orderId}/rider-candidates`)
  await check('order invoice', 'GET', `/v1/admin/orders/${orderId}/invoice`)
}

// ── people ───────────────────────────────────────────────────────────────────
await check('identity users', 'GET', '/v1/admin/users?limit=50')
await check('rider applications', 'GET', '/v1/admin/rider-applications?limit=50')

// ── payments ─────────────────────────────────────────────────────────────────
await check('payment attempts', 'GET', '/v1/admin/payments/attempts?limit=50')
await check('refunds', 'GET', '/v1/admin/refunds?limit=50')
await check('wallet ledger', 'GET', '/v1/admin/wallet/ledger?limit=50')
await check('reconciliation', 'GET', '/v1/admin/payments/reconciliation?limit=50')
await check('invoice render failures', 'GET', '/v1/admin/invoices/render-failures?limit=50')

// ── payouts ──────────────────────────────────────────────────────────────────
const payoutsPage = await fetch(BASE + '/v1/admin/payouts?limit=1', { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } }).then((r) => r.json())
const payoutId = payoutsPage?.items?.[0]?.id
await check('payouts', 'GET', '/v1/admin/payouts?limit=50')
if (payoutId) await check('payout corrections (per payout)', 'GET', `/v1/admin/payouts/${payoutId}/corrections?limit=50`)

// ── offers ───────────────────────────────────────────────────────────────────
await check('coupons', 'GET', '/v1/admin/coupons?limit=50')
await check('campaigns', 'GET', '/v1/admin/push-campaigns?limit=50')
await check('inbox', 'GET', '/v1/admin/notifications?limit=50')
await check('unread count', 'GET', '/v1/admin/notifications/unread-count')

// ── subscriptions ────────────────────────────────────────────────────────────
await check('subscription plans', 'GET', '/v1/admin/subscriptions/plans')
if (storeId) {
  await check('subscription slots', 'GET', `/v1/admin/subscriptions/slots?storeId=${storeId}`)
  await check('subscription holidays', 'GET', `/v1/admin/subscriptions/holidays?storeId=${storeId}`)
}
await check('subscription runs', 'GET', '/v1/admin/subscriptions/runs?limit=50')

// ── support ──────────────────────────────────────────────────────────────────
await check('tickets', 'GET', '/v1/admin/tickets?limit=50')
await check('canned responses', 'GET', '/v1/admin/canned-responses?limit=50')
await check('ratings queueOnly=true (string)', 'GET', '/v1/admin/ratings?queueOnly=true&limit=50')
const ticketId = (await fetch(BASE + '/v1/admin/tickets?limit=1', { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } }).then((r) => r.json()))?.items?.[0]?.id
if (ticketId) await check('ticket detail', 'GET', `/v1/admin/tickets/${ticketId}`)

// ── reports (catalog/stock are snapshot kinds: no from/to) ───────────────────
for (const kind of ['catalog', 'stock', 'financial', 'picking', 'rider', 'subscription', 'support']) {
  const window = ['catalog', 'stock'].includes(kind) ? '' : `&from=${new Date(today.getTime() - 29 * 86400000).toISOString()}&to=${today.toISOString()}`
  await check(`report ${kind}`, 'GET', `/v1/admin/reports/${kind}?limit=10${window}`)
}
await check('exports list', 'GET', '/v1/admin/reports/exports?limit=50')

// ── approvals & compliance ───────────────────────────────────────────────────
await check('approvals', 'GET', '/v1/admin/approvals?limit=50')
await check('fraud signals', 'GET', '/v1/admin/fraud-signals?limit=50')
await check('erasure requests', 'GET', '/v1/admin/erasure-requests?limit=50')
await check('legal holds', 'GET', '/v1/admin/legal-holds?limit=50')
await check('outbox status', 'GET', '/v1/admin/ops/outbox')
for (const concern of ['outbox', 'notifications', 'dispatch', 'payments', 'subscriptions', 'imports', 'maintenance']) {
  await check(`failed jobs ${concern}`, 'GET', `/v1/admin/ops/failed-jobs/${concern}`)
}

// ── settings ─────────────────────────────────────────────────────────────────
await check('config', 'GET', '/v1/admin/config')
await check('notification preferences', 'GET', '/v1/admin/notification-preferences')

// ── report ───────────────────────────────────────────────────────────────────
console.log('\n── non-2xx / unexpected calls ──')
let failures = 0
for (const r of results) {
  if (!r.ok) {
    failures++
    console.log(`${r.status}${r.expectStatus ? ` (expected ${r.expectStatus})` : ''} ${r.code ?? '-'}  ${r.method} ${r.path}`)
  }
}
console.log(`\n${results.length} calls, ${failures} unexpected`)
