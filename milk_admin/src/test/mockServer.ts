/**
 * Fetch stub harness for vitest — implements the pinned admin contract plus
 * representative existing endpoints over an in-memory dataset. No network.
 *
 * installMockServer() replaces window.fetch with a router; tests can override
 * any route's response per test via setRoute, and inspect requests via requests.
 */

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

export interface ProblemResponse {
  status: number
  body: { code: string; detail?: string; title?: string; traceId?: string }
}

type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: unknown; headers: Record<string, string> }) => unknown | ProblemResponse

let routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = []
export const requests: RecordedRequest[] = []

export function setRoute(method: string, pattern: RegExp, handler: Handler) {
  routes = routes.filter((r) => !(r.method === method && r.pattern.source === pattern.source))
  routes.push({ method, pattern, handler })
}

export function resetRoutes() {
  routes = []
  requests.length = 0
  installDefaultRoutes()
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

function match(method: string, path: string, body: unknown, headers: Record<string, string>): Response {
  const [pathname, search = ''] = path.split('?')
  const query = new URLSearchParams(search)
  for (const route of routes) {
    if (route.method !== method) continue
    const m = route.pattern.exec(pathname)
    if (!m) continue
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = decodeURIComponent(v)
    const result = route.handler({ params, query, body, headers })
    if (result instanceof Response) return result
    if (result && typeof result === 'object' && 'status' in (result as ProblemResponse) && 'body' in (result as ProblemResponse)) {
      const pr = result as ProblemResponse
      return json(pr.status, pr.body)
    }
    return json(200, result)
  }
  return json(404, { code: 'NOT_FOUND', detail: `No mock route for ${method} ${pathname}` })
}

// ── Seed dataset ─────────────────────────────────────────────────────────────
export const ADMIN = { userId: 'u-11111111-1111-4111-8111-111111111111', email: 'admin@dairydirect.in', name: 'Arjun Mehta', role: 'ADMIN' as const }
const STORE_ID = 'st-11111111-1111-4111-8111-111111111111'
const STORE2_ID = 'st-22222222-2222-4222-8222-222222222222'
const PRODUCT_ID = 'pr-11111111-1111-4111-8111-111111111111'
const VARIANT_ID = 'vr-11111111-1111-4111-8111-111111111111'
const ORDER_ID = 'or-11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = 'cu-11111111-1111-4111-8111-111111111111'
const TICKET_ID = 'tk-11111111-1111-4111-8111-111111111111'
const PAYOUT_ID = 'po-11111111-1111-4111-8111-111111111111'

const orderRow = {
  orderId: ORDER_ID,
  orderNumber: 'DD10001',
  userId: CUSTOMER_ID,
  storeId: STORE_ID,
  status: 'DELIVERED',
  onHold: false,
  hold: { held: false, reason: null, actorId: null, heldAt: null },
  paymentStatus: 'PAID',
  paymentMethod: 'GATEWAY',
  subtotalPaise: '42000',
  discountPaise: '0',
  feeTotalPaise: '4000',
  taxTotalPaise: '0',
  tipPaise: '0',
  totalPaise: '46000',
  walletPromoPaise: '0',
  walletCashPaise: '0',
  amountDuePaise: '0',
  currency: 'INR',
  placedAt: '2026-01-20T05:00:00.000Z',
  expiresAt: null,
  confirmedAt: '2026-01-20T05:05:00.000Z',
  deliveredAt: '2026-01-20T07:00:00.000Z',
  cancelReason: null,
  items: [{ id: 'it-1', variantId: VARIANT_ID, name: 'Cow Milk 500 ml', orderedQty: '2', fulfilledQty: '2', shortQty: '0', unitPricePaise: '21000', taxPaise: '0', lineStatus: 'FULFILLED' }],
  fees: [{ kind: 'DELIVERY', amountPaise: '4000', taxPaise: '0', taxSplit: null }],
  metadata: {},
  version: '1',
}

const storeRow = {
  id: STORE_ID,
  name: 'Powai Store',
  legal_entity_id: 'le-11111111-1111-4111-8111-111111111111',
  city_id: 'ci-11111111-1111-4111-8111-111111111111',
  status: 'ONLINE',
  pause_reason: null,
  hourly_capacity: 120,
  last_order_buffer_minutes: 30,
  accepts_cod: true,
  lat: 19.076,
  lng: 72.8777,
  version: '1',
}

let passwordResetCalls = 0
export let stateFlags = { cod: true, wallets: true, subscriptions: true }

export function getTestState() {
  return { passwordResetCalls: () => passwordResetCalls, ids: { STORE_ID, STORE2_ID, PRODUCT_ID, VARIANT_ID, ORDER_ID, CUSTOMER_ID, TICKET_ID, PAYOUT_ID } }
}

function page<T>(items: T[], nextCursor: string | null = null) {
  return { items, nextCursor }
}

export function installDefaultRoutes() {
  // ── auth (pinned contract) ──
  setRoute('POST', /^\/v1\/admin\/auth\/login$/, ({ body }) => {
    const b = body as { email: string; password: string }
    if (b.email === 'challenge@dairydirect.in') {
      return { status: 'CHALLENGE', challenge: 'NEW_PASSWORD_REQUIRED', challengeId: 'ch-123' }
    }
    if (b.password === 'wrongpass') {
      return { status: 401, body: { code: 'INVALID_CREDENTIALS', detail: 'Invalid email or password.' } } as unknown as ProblemResponse
    }
    return { status: 'AUTHENTICATED', admin: ADMIN, csrfToken: 'csrf-test-token' }
  })
  setRoute('POST', /^\/v1\/admin\/auth\/challenge$/, ({ body }) => {
    const b = body as { challengeId: string; newPassword: string }
    if (!b.newPassword || b.newPassword.length < 12) {
      return { status: 400, body: { code: 'INVALID_INPUT', detail: 'Password policy not met' } } as unknown as ProblemResponse
    }
    return { status: 'AUTHENTICATED', admin: ADMIN, csrfToken: 'csrf-test-token' }
  })
  setRoute('POST', /^\/v1\/admin\/auth\/forgot-password$/, () => ({ status: 'SENT' }))
  setRoute('POST', /^\/v1\/admin\/auth\/forgot-password\/confirm$/, ({ body }) => {
    const b = body as { confirmationCode: string; newPassword: string }
    if (b.confirmationCode !== '123456' || (b.newPassword ?? '').length < 12) {
      return { status: 400, body: { code: 'INVALID_RESET', detail: 'Invalid reset code or password.' } } as unknown as ProblemResponse
    }
    return { status: 'RESET' }
  })
  setRoute('GET', /^\/v1\/admin\/auth\/session$/, ({ headers }) => {
    if (headers.cookie === 'expired') {
      return { status: 401, body: { code: 'SESSION_EXPIRED' } } as unknown as ProblemResponse
    }
    return { admin: ADMIN, csrfToken: 'csrf-test-token' }
  })
  setRoute('POST', /^\/v1\/admin\/auth\/logout$/, ({ headers }) => {
    if (headers['x-admin-csrf'] !== 'csrf-test-token') {
      return { status: 403, body: { code: 'FORBIDDEN', detail: 'CSRF token missing' } } as unknown as ProblemResponse
    }
    return { status: 'LOGGED_OUT' }
  })

  // ── dashboard (pinned) ──
  setRoute('GET', /^\/v1\/admin\/dashboard$/, () => ({
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
    invoicedSalesPaise: '104000',
    creditNotesPaise: '4000',
    refundsProcessedPaise: '12000',
    walletTopUpsPaise: { total: '50000' },
    orders: { placed: 48, confirmed: 20, picking: 30, packed: 10, outForDelivery: 62, delivered: 982, cancelled: 24, expired: 10, onHold: 12 },
    stores: { total: 8, online: 6 },
    customers: { total: 480, active: 210 },
  }))

  // ── stores / serviceability ──
  setRoute('GET', /^\/v1\/admin\/stores$/, () => page([storeRow, { ...storeRow, id: STORE2_ID, name: 'Colaba Store', status: 'PAUSED', pause_reason: 'backlog', accepts_cod: false, version: '3' }]))
  setRoute('POST', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/status$/, ({ body }) => body)
  setRoute('PATCH', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/cod$/, ({ body }) => body)
  setRoute('GET', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/operations$/, () => ({
    hours: [{ weekday: 1, start_minute: 360, end_minute: 780 }],
    holidays: [{ day: '2026-01-26', closed: true }],
    holidayHours: [],
    staff: [{ user_id: 'wf-22222222-2222-4222-8222-222222222222', role: 'STORE_MANAGER' }],
    nextHolidayCursor: null,
    nextStaffCursor: null,
  }))
  setRoute('PUT', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/hours$/, ({ body }) => body)
  setRoute('PUT', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/holidays$/, ({ body }) => body)
  setRoute('DELETE', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/holidays\/(?<day>[^/]+)$/, () => ({}))
  setRoute('PUT', /^\/v1\/admin\/stores\/(?<id>[^/]+)\/staff$/, ({ body }) => body)
  setRoute('GET', /^\/v1\/admin\/cities$/, () => page([{ id: 'ci-11111111-1111-4111-8111-111111111111', name: 'Mumbai', bounds: { type: 'Polygon', coordinates: [[[72.8, 19.0], [72.9, 19.0], [72.9, 19.1], [72.8, 19.0]]] }, zone_version: '1' }]))
  setRoute('GET', /^\/v1\/admin\/legal-entities$/, () => page([{ id: 'le-11111111-1111-4111-8111-111111111111', name: 'DairyDirect Retail Pvt Ltd' }]))
  setRoute('GET', /^\/v1\/admin\/zones$/, () => page([{
    id: 'zo-11111111-1111-4111-8111-111111111111', store_id: STORE_ID, name: 'Powai belt',
    priority: 1, active: true, version: '1',
    geometry: { type: 'Polygon', coordinates: [[[72.87, 19.07], [72.89, 19.07], [72.89, 19.09], [72.87, 19.07]]] },
  }]))
  setRoute('POST', /^\/v1\/admin\/zones$/, ({ body }) => ({ id: 'zo-new', version: '1', cityZoneVersion: '2', ...(body as object) }))

  // ── catalog ──
  setRoute('GET', /^\/v1\/admin\/catalog\/products$/, () => page([{
    id: PRODUCT_ID, name: 'Cow Milk', categoryId: 'ca-1', brandId: 'br-1',
    description: 'Fresh cow milk', hsnCode: '0401', gstRateBps: 0,
    perishable: true, expiryTracking: true, published: true,
  }]))
  setRoute('GET', /^\/v1\/admin\/catalog\/variants$/, () => page([
    { id: VARIANT_ID, name: '500 ml', productId: PRODUCT_ID, baseUnit: 'MILLILITRE', sku: 'DD-MILK-500', barcode: '8901234567890' },
  ]))
  setRoute('GET', /^\/v1\/admin\/catalog\/categories$/, () => page([{ id: 'ca-1', name: 'Milk' }]))
  setRoute('GET', /^\/v1\/admin\/catalog\/brands$/, () => page([{ id: 'br-1', name: 'DairyDirect Classic' }]))
  setRoute('POST', /^\/v1\/admin\/catalog\/prices$/, () => ({ approvalId: 'ap-price-1' }))
  setRoute('POST', /^\/v1\/admin\/catalog\/assortment$/, () => ({}))
  setRoute('POST', /^\/v1\/admin\/catalog\/media\/targets$/, () => ({ mediaId: 'md-1', url: 'https://upload.test/put', fields: {} }))
  setRoute('POST', /^\/v1\/admin\/catalog\/imports$/, () => ({ id: 'im-1' }))
  setRoute('GET', /^\/v1\/admin\/catalog\/imports\/(?<id>[^/]+)$/, () => ({
    id: 'im-1', status: 'COMPLETED', dryRun: true, rowsTotal: 10, checkpoint: 10, errors: [], approvalId: null,
    createdAt: '2026-01-20T00:00:00.000Z', updatedAt: '2026-01-20T00:00:00.000Z',
  }))

  // ── inventory ──
  setRoute('GET', /^\/v1\/admin\/inventory\/report$/, () => page([
    { variantId: VARIANT_ID, onHand: '24', reserved: '2', available: '22', version: '1' },
  ]))
  setRoute('GET', /^\/v1\/admin\/inventory\/ledger$/, () => page([
    { id: 'lg-1', reference: 'RCPT-1', variantId: VARIANT_ID, batchId: 'b-1', kind: 'RECEIPT', onHandDelta: '24', reservedDelta: '0', actorId: null, createdAt: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('GET', /^\/v1\/admin\/inventory\/summary$/, () => page([
    { variantId: VARIANT_ID, sku: 'DD-MILK-500', name: 'Cow Milk 500 ml', units: 48, availableStores: 2, lowStockStores: 0, totalReserved: 2 },
  ]))
  setRoute('GET', /^\/v1\/admin\/inventory\/shelf-life$/, () => page([{ categoryId: 'ca-1', minSeconds: 604800, version: '1' }]))
  setRoute('POST', /^\/v1\/admin\/inventory\/shelf-life$/, () => ({}))

  // ── orders ──
  setRoute('GET', /^\/v1\/admin\/orders$/, ({ query }) => {
    if (query.get('cursor') === 'c2') {
      return page([{ ...orderRow, orderId: 'or-22222222-2222-4222-8222-222222222222', orderNumber: 'DD10002', status: 'OUT_FOR_DELIVERY', onHold: true, hold: { held: true, reason: 'customer unreachable', actorId: ADMIN.userId, heldAt: '2026-01-20T06:00:00.000Z' } }])
    }
    return { items: [orderRow], nextCursor: 'c2' }
  })
  setRoute('GET', /^\/v1\/admin\/orders\/(?<id>[^/]+)$/, ({ params }) => {
    if (params.id !== ORDER_ID) return { status: 404, body: { code: 'ORDER_NOT_FOUND' } } as unknown as ProblemResponse
    return orderRow
  })
  setRoute('GET', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/timeline$/, () => ([
    { previousState: null, state: 'CONFIRMED', action: 'CONFIRMED', actorType: 'SYSTEM', actorId: null, reason: null, at: '2026-01-20T05:05:00.000Z' },
  ]))
  setRoute('GET', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/payments$/, () => ({
    attempts: [{ attemptId: 'at-1', orderId: ORDER_ID, operationReference: 'op-1', kind: 'ORDER_PAYMENT', gatewayOrderId: 'gw-o-1', gatewayPaymentId: 'gw-p-1', amountPaise: '46000', currency: 'INR', status: 'CAPTURED', createdAt: '2026-01-20T05:00:00.000Z' }],
    refunds: [{ refundId: 'rf-1', refundReference: 'RF-1', orderId: ORDER_ID, sourceType: 'GATEWAY_CAPTURE', sourceId: 'gw-p-1', amountPaise: '12000', destination: 'GATEWAY', status: 'PROCESSED', gatewayRefundId: 'gwr-1', reason: 'Damaged item' }],
  }))
  setRoute('GET', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/rider-candidates$/, () => ({
    items: [
      { riderId: 'rd-1', name: 'Rider One', eligible: true, reason: null },
      { riderId: 'rd-2', name: 'Rider Two', eligible: false, reason: 'Off duty today' },
    ],
  }))
  setRoute('GET', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/invoice$/, () => ({ url: 'https://invoices.test/signed', expiresIn: 300, documentId: 'doc-1', number: 'INV-1' }))
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/hold$/, ({ body }) => body)
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/cancel$/, ({ body }) => ({ ...orderRow, status: 'CANCELLED', cancelReason: (body as { reason: string }).reason }))
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/delivery-code\/reset$/, () => ({ state: 'RESET' }))
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/refunds$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { approvalId: 'ap-refund-1' }
  })
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/force-state$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { approvalId: 'ap-repair-1' }
  })
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/reassign-rider$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { state: 'ASSIGNED' }
  })
  setRoute('POST', /^\/v1\/admin\/orders\/(?<id>[^/]+)\/wrong-address\/resolve$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { state: 'RESOLVED' }
  })

  // ── fleet (pinned) ──
  setRoute('GET', /^\/v1\/admin\/delivery\/fleet$/, () => ({
    items: [
      { riderId: 'rd-1', name: 'Rider One', storeId: STORE_ID, availability: 'AVAILABLE', lastLocation: { lat: 19.08, lng: 72.88 }, lastUpdateAt: new Date().toISOString(), fresh: true },
      { riderId: 'rd-2', name: 'Rider Two', storeId: STORE2_ID, availability: 'OFFLINE', lastLocation: null, lastUpdateAt: '2026-01-20T00:00:00.000Z', fresh: false },
    ],
    freshnessSeconds: 60,
  }))

  // ── people / identity ──
  setRoute('GET', /^\/v1\/admin\/users$/, () => ({
    users: [
      { userId: CUSTOMER_ID, email: 'meera@example.in', name: 'Meera Kulkarni', pool: 'CUSTOMER', status: 'ACTIVE', roles: [] },
      { userId: 'wf-22222222-2222-4222-8222-222222222222', email: 'rohit@dairydirect.in', name: 'Rohit Kulkarni', pool: 'WORKFORCE', status: 'ACTIVE', roles: ['STORE_MANAGER'] },
    ],
    nextCursor: null,
  }))
  setRoute('POST', /^\/v1\/admin\/users\/workforce$/, ({ body }) => ({ operationId: 'op-1', userId: 'wf-new', ...(body as object) }))
  setRoute('POST', /^\/v1\/admin\/users\/(?<id>[^/]+)\/block$/, ({ body }) => body)
  setRoute('POST', /^\/v1\/admin\/users\/(?<id>[^/]+)\/password-reset$/, () => { passwordResetCalls += 1; return {} })
  setRoute('POST', /^\/v1\/admin\/users\/(?<id>[^/]+)\/roles\/requests$/, () => ({ requestId: 'rc-1' }))
  setRoute('GET', /^\/v1\/admin\/rider-applications$/, () => page([{ userId: 'rd-app-1', name: 'Applicant One', email: 'a@example.in', status: 'PENDING' }]))
  setRoute('GET', /^\/v1\/admin\/rider-applications\/(?<id>[^/]+)$/, () => ({
    userId: 'rd-app-1', status: 'PENDING', vehicleType: 'SCOOTER', vehicleNo: 'MH01AB1234',
    homeStoreId: STORE_ID, requiredDocuments: ['license'], documents: [{ id: 'doc-1', type: 'license', status: 'PENDING', reason: null, createdAt: '2026-01-20T00:00:00.000Z' }],
  }))

  // ── payments (pinned attempts/refunds lists) ──
  setRoute('GET', /^\/v1\/admin\/payments\/attempts$/, () => page([
    { attemptId: 'at-1', orderId: ORDER_ID, operationReference: 'op-1', kind: 'ORDER_PAYMENT', gatewayPaymentId: 'gw-p-1', amountPaise: '46000', currency: 'INR', status: 'CAPTURED', createdAt: '2026-01-20T05:00:00.000Z' },
  ]))
  setRoute('GET', /^\/v1\/admin\/refunds$/, () => page([
    { refundId: 'rf-1', refundReference: 'RF-1', orderId: ORDER_ID, sourceType: 'GATEWAY_CAPTURE', amountPaise: '12000', destination: 'GATEWAY', status: 'PROCESSED', gatewayRefundId: 'gwr-1', reason: 'Damaged item' },
    { refundId: 'rf-2', refundReference: 'RF-2', orderId: ORDER_ID, sourceType: 'GATEWAY_CAPTURE', amountPaise: '5000', destination: 'MANUAL_PAYOUT', status: 'PENDING', gatewayRefundId: null, reason: 'Goodwill' },
  ]))
  setRoute('GET', /^\/v1\/admin\/wallet\/ledger$/, () => page([
    { id: 'wl-1', userId: CUSTOMER_ID, bucket: 'cash', deltaPaise: '50000', reason: 'TOPUP_CREDIT', refType: 'topup', refId: 'tp-1', balanceAfter: '50000', createdAt: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/wallet\/adjustments$/, () => ({ approvalId: 'ap-wallet-1' }))
  setRoute('GET', /^\/v1\/admin\/payments\/reconciliation$/, () => page([
    { id: 'rc-1', kind: 'MISMATCH', severity: 'HIGH', aggregate_type: 'order', aggregate_id: ORDER_ID, reference: 'RC-01', details: {}, status: 'OPEN', resolved_by: null, resolved_at: null, created_at: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/payments\/reconciliation\/(?<id>[^/]+)\/review$/, ({ body }) => body)
  setRoute('GET', /^\/v1\/admin\/invoices\/render-failures$/, () => page([
    { documentId: 'doc-1', number: 'INV-404', attempts: 3, suspendedAt: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/invoices\/(?<id>[^/]+)\/render-retry$/, () => ({ documentId: 'doc-1', status: 'PENDING' }))
  setRoute('POST', /^\/v1\/admin\/payout-evidence$/, () => ({ mediaId: 'ev-1', url: 'https://upload.test/put', fields: {} }))

  // ── payouts ──
  setRoute('GET', /^\/v1\/admin\/payouts$/, () => page([
    { id: PAYOUT_ID, rider_id: 'rd-1', state: 'PENDING_APPROVAL', gross_paise: '800000', cash_offset_paise: '120000', net_paise: '680000', created_at: '2026-01-20T00:00:00.000Z', approved_at: null, paid_at: null },
  ]))
  setRoute('POST', /^\/v1\/admin\/payouts\/(?<id>[^/]+)\/approval$/, () => ({ approvalId: 'ap-payout-1' }))
  setRoute('POST', /^\/v1\/admin\/payout-approvals\/(?<id>[^/]+)\/execute$/, () => ({ approved: true }))
  setRoute('GET', /^\/v1\/admin\/payouts\/(?<id>[^/]+)\/corrections$/, () => page([
    { id: 'pc-1', payout_id: PAYOUT_ID, delta_paise: '5000', reason: 'Missed COD pickup', state: 'SETTLED', created_at: '2026-01-20T00:00:00.000Z', settled_at: '2026-01-21T00:00:00.000Z', payment_reference: 'UTR-1' },
  ]))
  setRoute('POST', /^\/v1\/admin\/payouts\/(?<id>[^/]+)\/corrections$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { approvalId: 'ap-corr-1' }
  })
  setRoute('POST', /^\/v1\/admin\/payouts\/(?<id>[^/]+)\/cancel$/, () => ({ cancelled: true }))
  setRoute('POST', /^\/v1\/admin\/payouts\/(?<id>[^/]+)\/paid$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { paid: true }
  })

  // ── offers & notifications ──
  setRoute('GET', /^\/v1\/admin\/coupons$/, () => page([
    { id: 'cp-1', code: 'FREEDLY', kind: 'PERCENT', value_bps: '1000', min_order_paise: '49900', active: true, version: '1', stackable: false, first_order_only: false },
  ]))
  setRoute('POST', /^\/v1\/admin\/coupons$/, () => ({ id: 'cp-new' }))
  setRoute('PATCH', /^\/v1\/admin\/coupons\/(?<id>[^/]+)$/, () => ({ id: 'cp-1' }))
  setRoute('POST', /^\/v1\/admin\/push-campaigns\/preview$/, () => ({ estimatedRecipients: 42 }))
  setRoute('POST', /^\/v1\/admin\/push-campaigns$/, () => ({ id: 'pmc-1' }))
  setRoute('GET', /^\/v1\/admin\/push-campaigns$/, () => page([
    { id: 'pmc-1', title: 'Republic Day', body: 'Fresh deals!', kind: 'PROMOTIONAL', target: { mode: 'ALL', apps: ['CUSTOMER'] }, estimated_recipients: 42, created_at: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('GET', /^\/v1\/admin\/notifications$/, () => page([
    { id: 'nt-1', channel: 'INBOX', templateKey: 'ops.alert', title: 'Payout cycle ready', body: 'Weekly payouts drafted', category: 'ADMIN', class: 'TRANSACTIONAL', read_at: null, created_at: new Date().toISOString() },
  ]))
  setRoute('GET', /^\/v1\/admin\/notifications\/unread-count$/, () => ({ count: 1 }))
  setRoute('POST', /^\/v1\/admin\/notifications\/(?<id>[^/]+)\/read$/, () => ({ read: true }))
  setRoute('POST', /^\/v1\/admin\/notifications\/read-all$/, () => ({ updated: 1 }))
  setRoute('GET', /^\/v1\/admin\/notification-preferences$/, () => ([{ category: 'ADMIN', enabled: true }, { category: 'PROMOTIONS', enabled: false }]))
  setRoute('PATCH', /^\/v1\/admin\/notification-preferences$/, ({ body }) => body)

  // ── subscriptions ──
  setRoute('GET', /^\/v1\/admin\/subscriptions\/plans$/, () => page([{ variantId: VARIANT_ID, active: true, version: '1' }]))
  setRoute('PUT', /^\/v1\/admin\/subscriptions\/plans$/, () => ({}))
  setRoute('GET', /^\/v1\/admin\/subscriptions\/slots$/, () => page([
    { id: 'sl-1', storeId: STORE_ID, name: 'Morning 6–9', startTime: '06:00', endTime: '09:00', active: true, version: '1' },
  ]))
  setRoute('PUT', /^\/v1\/admin\/subscriptions\/slots$/, () => ({}))
  setRoute('GET', /^\/v1\/admin\/subscriptions\/holidays$/, () => page([{ storeId: STORE_ID, date: '2026-01-26', reason: 'Republic Day' }]))
  setRoute('PUT', /^\/v1\/admin\/subscriptions\/holidays$/, () => ({}))
  setRoute('DELETE', /^\/v1\/admin\/subscriptions\/holidays\/(?<storeId>[^/]+)\/(?<date>[^/]+)$/, () => ({}))
  setRoute('GET', /^\/v1\/admin\/subscriptions\/runs$/, () => page([
    { id: 'run-1', storeId: STORE_ID, runDate: '2026-01-20', status: 'PARTIAL', generatedCount: 40, failedCount: 2, lastError: 'wallet blocked', createdAt: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/subscriptions\/runs\/(?<id>[^/]+)\/retry$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { retried: 2 }
  })

  // ── support ──
  setRoute('GET', /^\/v1\/admin\/tickets$/, () => page([
    { id: TICKET_ID, order_id: ORDER_ID, category: 'order_issue', status: 'OPEN', assignee_id: null, created_at: '2026-01-20T00:00:00.000Z', updated_at: '2026-01-20T01:00:00.000Z' },
  ]))
  setRoute('GET', /^\/v1\/admin\/tickets\/(?<id>[^/]+)$/, () => ({
    ticket: { id: TICKET_ID, order_id: ORDER_ID, category: 'order_issue', status: 'OPEN', assignee_id: null, created_at: '2026-01-20T00:00:00.000Z', updated_at: '2026-01-20T01:00:00.000Z', owner_id: CUSTOMER_ID },
    messages: [
      { id: 'm-1', author_id: CUSTOMER_ID, body: 'Milk was leaking', internal: false, created_at: '2026-01-20T00:00:00.000Z', attachments: [] },
    ],
    nextMessagesCursor: null,
  }))
  setRoute('POST', /^\/v1\/admin\/tickets\/(?<id>[^/]+)\/messages$/, ({ body, headers }) => {
    if (!headers['idempotency-key'] && !(body as { reference?: string }).reference) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { id: 'm-new' }
  })
  setRoute('PATCH', /^\/v1\/admin\/tickets\/(?<id>[^/]+)$/, ({ body }) => ({ updated: true, body }))
  setRoute('POST', /^\/v1\/admin\/ticket-attachments$/, () => ({ mediaId: 'ta-1', url: 'https://upload.test/put', fields: {} }))
  setRoute('GET', /^\/v1\/admin\/tickets\/(?<id>[^/]+)\/attachments\/(?<mediaId>[^/]+)$/, () => ({ url: 'https://media.test/signed' }))
  setRoute('GET', /^\/v1\/admin\/canned-responses$/, () => page([{ id: 'cr-1', label: 'Leaking package', body: 'Sorry about the leak — a replacement is on the way.' }]))
  setRoute('POST', /^\/v1\/admin\/canned-responses$/, ({ body }) => ({ id: 'cr-new', ...(body as object) }))
  setRoute('GET', /^\/v1\/admin\/ratings$/, () => page([
    { id: 'rt-1', targetType: 'ORDER', targetId: ORDER_ID, stars: 2, comment: 'Late delivery', hidden: false, needsModeration: true, createdAt: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('PATCH', /^\/v1\/admin\/ratings\/(?<id>[^/]+)\/moderation$/, ({ body }) => ({ updated: true, body }))
  setRoute('POST', /^\/v1\/admin\/tickets\/(?<id>[^/]+)\/refunds$/, ({ body }) => {
    if (!(body as { idempotencyKey?: string }).idempotencyKey) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { status: 'APPROVAL_REQUIRED', approvalId: 'ap-trefund-1' }
  })
  setRoute('POST', /^\/v1\/admin\/ticket-refund-approvals\/(?<id>[^/]+)\/execute$/, () => ({ approved: true }))

  // ── reports ──
  setRoute('GET', /^\/v1\/admin\/reports\/(?<kind>[a-z]+)$/, () => page([
    { period: '2026-01', orders: 30, revenue_paise: '104000' },
    { period: '2025-12', orders: 28, revenue_paise: '98000' },
  ]))
  setRoute('POST', /^\/v1\/admin\/reports\/exports$/, ({ headers }) => {
    if (!headers['idempotency-key']) {
      return { status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } } as unknown as ProblemResponse
    }
    return { id: 'ex-1' }
  })
  setRoute('GET', /^\/v1\/admin\/reports\/exports$/, () => page([
    { id: 'ex-1', kind: 'financial', status: 'COMPLETE', row_count: '120', created_at: '2026-01-20T00:00:00.000Z', updated_at: '2026-01-20T00:01:00.000Z', expires_at: null },
  ]))
  setRoute('GET', /^\/v1\/admin\/reports\/exports\/(?<id>[^/]+)$/, () => ({ id: 'ex-1', kind: 'financial', status: 'COMPLETE', row_count: '120', created_at: '2026-01-20T00:00:00.000Z', updated_at: '2026-01-20T00:01:00.000Z', expires_at: null }))
  setRoute('GET', /^\/v1\/admin\/reports\/exports\/(?<id>[^/]+)\/download$/, () => ({ url: 'https://exports.test/signed.xlsx' }))

  // ── approvals & compliance ──
  setRoute('GET', /^\/v1\/admin\/approvals$/, () => page([
    { id: 'ap-1', action: 'wallet.adjustment', maker_id: CUSTOMER_ID, checker_id: null, required_role: 'SUPER_ADMIN', status: 'PENDING', expires_at: '2026-02-01T00:00:00.000Z', created_at: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/approvals\/(?<id>[^/]+)\/reject$/, ({ body }) => body)
  setRoute('GET', /^\/v1\/admin\/fraud-signals$/, () => page([
    { id: 'fr-1', kind: 'REFUND_ABUSE', severity: 'HIGH', status: 'OPEN', created_at: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/fraud-signals\/(?<id>[^/]+)\/review$/, ({ body }) => body)
  setRoute('GET', /^\/v1\/admin\/erasure-requests$/, () => page([
    { id: 'er-1', user_id: CUSTOMER_ID, status: 'PENDING', blockers: [], created_at: '2026-01-20T00:00:00.000Z', updated_at: '2026-01-20T00:00:00.000Z' },
  ]))
  setRoute('POST', /^\/v1\/admin\/erasure-requests\/(?<id>[^/]+)\/retry$/, () => ({}))
  setRoute('GET', /^\/v1\/admin\/legal-holds$/, () => page([
    { id: 'lh-1', user_id: CUSTOMER_ID, reason: 'Active investigation', created_at: '2026-01-20T00:00:00.000Z', released_at: null },
  ]))
  setRoute('POST', /^\/v1\/admin\/users\/(?<id>[^/]+)\/legal-holds$/, () => ({ id: 'lh-new' }))
  setRoute('POST', /^\/v1\/admin\/legal-holds\/(?<id>[^/]+)\/release$/, () => ({}))
  setRoute('GET', /^\/v1\/admin\/ops\/failed-jobs\/(?<concern>[^/]+)$/, () => ([
    { id: 'job-1', name: 'invoice-render', attempts: 2, failedAt: 1769000000000 },
  ]))
  setRoute('POST', /^\/v1\/admin\/ops\/failed-jobs\/(?<concern>[^/]+)\/(?<id>[^/]+)\/replay$/, () => ({}))
  setRoute('GET', /^\/v1\/admin\/ops\/outbox$/, () => ({ pending: '3', suspended: '1', oldest_pending: '2026-01-20T00:00:00.000Z', latest_processed: '2026-01-21T00:00:00.000Z' }))

  // ── config (pinned) ──
  setRoute('GET', /^\/v1\/admin\/config$/, () => ({
    config: { minOrderPaise: '14900', deliveryFeeSlabs: [] },
    flags: { cod_enabled: stateFlags.cod, wallets_enabled: stateFlags.wallets, subscriptions_enabled: stateFlags.subscriptions },
  }))
  setRoute('POST', /^\/v1\/admin\/config\/(?<key>[^/]+)$/, ({ body }) => body)
  setRoute('POST', /^\/v1\/admin\/feature-flags\/(?<key>[^/]+)$/, ({ body }) => body)

  // ── global search (pinned) ──
  setRoute('GET', /^\/v1\/admin\/search$/, ({ query }) => {
    const q = query.get('q') ?? ''
    if (!q) return { groups: [] }
    return {
      groups: [
        { group: 'Orders', items: [{ id: ORDER_ID, title: 'DD10001', sub: 'Meera · ₹460' }] },
        { group: 'Stores', items: [{ id: STORE_ID, title: 'Powai Store', sub: 'Mumbai' }] },
        { group: 'Customers', items: [{ id: CUSTOMER_ID, title: 'Meera Kulkarni', sub: 'meera@example.in' }] },
      ],
    }
  })
}

let installed = false

/** Pristine (Node) fetch captured before the stub patches globalThis — used by the REAL-mode probe/transport. */
export const pristineFetch: typeof fetch = globalThis.fetch

/**
 * FALLBACK-ONLY transport stub (labeled per user directive): replaces
 * globalThis.fetch with the route-table router so src/api/http.ts (bare
 * fetch) is intercepted in jsdom. This never touches the app data path in
 * production — it exists only so a handful of component tests can run when
 * the real server is unreachable.
 */
export function installMockServer() {
  if (installed) return
  installDefaultRoutes()
  installed = true
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = undefined
    if (init?.body) {
      try { body = JSON.parse(String(init.body)) } catch { body = init.body }
    }
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = String(v)
    }
    requests.push({ method, path: url, body, headers })
    return match(method, url, body, headers)
  }) as typeof fetch
}
