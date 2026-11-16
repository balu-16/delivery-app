import { expect, test, type Page, type Route } from '@playwright/test'

const STORE_A = '22222222-2222-4222-8222-222222222222'
const STORE_B = '33333333-3333-4333-8333-333333333333'
const empty = { items: [], nextCursor: null }

type FixtureOptions = {
  assigned?: boolean
  failPath?: string
  failStatus?: number
  slowStoreB?: boolean
}

/** All API traffic is intercepted, so these tests never write to the live backend. */
async function installApi(page: Page, options: FixtureOptions = {}) {
  let failureEnabled = Boolean(options.failPath)
  await page.route('**/v1/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { code: 'READ_ONLY_TEST' } })
    if (url.pathname === '/v1/store/auth/session') {
      return route.fulfill({ json: {
        manager: {
          userId: '11111111-1111-4111-8111-111111111111', name: 'Test Manager', email: 'manager@example.test',
          stores: options.assigned === false ? [] : [
            { storeId: STORE_A, name: 'Central Test Store', role: 'STORE_MANAGER' },
            { storeId: STORE_B, name: 'South Test Store', role: 'STORE_MANAGER' },
          ],
        },
        csrfToken: 'test-csrf', idleExpiresAt: '2099-01-01T00:00:00.000Z',
      } })
    }
    if (failureEnabled && url.pathname === options.failPath) {
      return route.fulfill({ status: options.failStatus ?? 403, json: { code: 'TEST_REQUEST_FAILED' } })
    }
    const storeId = url.searchParams.get('storeId') ?? STORE_A
    if (url.pathname === '/v1/store/dashboard') {
      return route.fulfill({ json: {
        kpis: { openTasks: 0, completedToday: 0, slaBreachesToday: 0, avgPickSeconds: '0', shortRateBps: '0', backlog: 0 },
        board: { waiting: 0, beingPicked: 0, readyToPack: 0, readyForHandover: 0, hourly: [] },
        workload: { staff: [], breaches: [] }, upcomingTasks: [], alerts: { unreadNotifications: 0 },
        store: { status: 'ONLINE', pauseReason: null, version: '1' },
      } })
    }
    if (url.pathname === '/v1/store/status') {
      return route.fulfill({ json: { store: {
        storeId, name: storeId === STORE_B ? 'South Test Store' : 'Central Test Store', status: 'ONLINE',
        pauseReason: null, version: '1', location: null, hourlyCapacity: 100, lastOrderBufferMinutes: 0, hours: [],
      }, history: [] } })
    }
    if (url.pathname === '/v1/store/notification-preferences') return route.fulfill({ json: [] })
    if (url.pathname === '/v1/store/returns' && url.searchParams.get('tab') === 'ELIGIBLE') {
      if (options.slowStoreB && storeId === STORE_B) await new Promise((resolve) => setTimeout(resolve, 600))
      return route.fulfill({ json: { items: [{
        orderId: '44444444-4444-4444-8444-444444444444',
        orderNumber: storeId === STORE_B ? 'BETA-99' : 'ALPHA-11', customerName: 'Test Customer',
        failureReason: 'CUSTOMER_UNAVAILABLE', failedAt: '2026-01-20T10:00:00.000Z', itemCount: 1, totalPaise: '5000',
      }], nextCursor: null } })
    }
    if (url.pathname === '/v1/store/returns' && url.searchParams.get('tab') === 'RECORDED') {
      return route.fulfill({ json: { items: [{
        returnId: '66666666-6666-4666-8666-666666666666', orderId: '44444444-4444-4444-8444-444444444444',
        orderNumber: 'RECORDED-1', customerName: 'Test Customer', failureReason: 'CUSTOMER_UNAVAILABLE',
        variantId: '77777777-7777-4777-8777-777777777777', variantName: 'Test Milk', quantity: '1',
        status: 'QUARANTINED', reason: null, createdAt: '2026-01-20T10:00:00.000Z', inspectedAt: null,
      }], nextCursor: null } })
    }
    if (/^\/v1\/store\/returns\/orders\/[^/]+\/draft$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'application/json', body: 'null' })
    }
    if (/^\/v1\/store\/returns\/orders\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: {
        orderId: '44444444-4444-4444-8444-444444444444', orderNumber: 'RECORDED-1', customerName: 'Test Customer',
        status: 'RETURNED_TO_STORE', failureReason: 'CUSTOMER_UNAVAILABLE', failedAt: '2026-01-20T10:00:00.000Z', totalPaise: '5000',
        items: [{ variantId: '77777777-7777-4777-8777-777777777777', variantName: 'Test Milk', quantity: '1', expiresAt: null }],
        returns: [{ returnId: '66666666-6666-4666-8666-666666666666', orderId: '44444444-4444-4444-8444-444444444444',
          variantId: '77777777-7777-4777-8777-777777777777', variantName: 'Test Milk', quantity: '1',
          status: 'QUARANTINED', reason: null, createdAt: '2026-01-20T10:00:00.000Z', inspectedAt: null }],
      } })
    }
    if (url.pathname === '/v1/store/rider-applications') {
      return route.fulfill({ json: { items: [{
        userId: '55555555-5555-4555-8555-555555555555', name: 'Test Rider', status: 'PENDING',
        appliedAt: '2026-01-20T10:00:00.000Z', homeStoreId: storeId, vehicleType: 'bike', vehicleNo: 'TEST-123', documents: [],
      }], nextCursor: null } })
    }
    if (/^\/v1\/store\/rider-applications\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: {
        userId: '55555555-5555-4555-8555-555555555555', name: 'Test Rider', status: 'PENDING',
        appliedAt: '2026-01-20T10:00:00.000Z', homeStoreId: storeId, vehicleType: 'bike', vehicleNo: 'TEST-123', documents: [],
      } })
    }
    if (url.pathname === '/v1/store/cod/deposits') return route.fulfill({ json: { ...empty, totals: { depositedPaise: '0', discrepancyPaise: '0', count: 0 } } })
    if (url.pathname === '/v1/store/search') return route.fulfill({ json: { items: [] } })
    return route.fulfill({ json: empty })
  })
  return { allowRequests: () => { failureEnabled = false } }
}

/** Playwright's isVisible ignores opacity; assert the full ancestor chain too. */
async function expectVisibleHeading(page: Page, name: RegExp) {
  const heading = page.getByRole('heading', { level: 1, name })
  await expect(heading).toBeVisible()
  await expect.poll(() => heading.evaluate((element) => {
    let current: HTMLElement | null = element
    while (current) {
      const style = window.getComputedStyle(current)
      if (Number(style.opacity) === 0 || style.visibility === 'hidden' || style.display === 'none') return false
      current = current.parentElement
    }
    return true
  })).toBe(true)
}

test.use({ serviceWorkers: 'block' })

test('all nine sidebar routes stay visible after navigation, refresh, and history', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await installApi(page)
  await page.goto('/dashboard')
  await expectVisibleHeading(page, /Good .*Test/)
  const sections: Array<[string, RegExp, string]> = [
    ['Orders & Picking', /Orders & Picking/, 'orders-picking'],
    ['Inventory', /^Inventory$/, 'inventory'],
    ['Returns & Quality Checks', /Returns & Quality Checks/, 'returns'],
    ['Rider Applications', /Rider Applications/, 'rider-applications'],
    ['COD Cash Deposits', /COD Cash Deposits/, 'cod-deposits'],
    ['Store Status', /Store Status/, 'store-status'],
    ['Staff & Workload', /Staff & Workload/, 'staff-workload'],
    ['Notifications & Account', /Notifications & Account/, 'notifications'],
  ]
  for (const [label, heading, artwork] of sections) {
    await page.getByRole('link', { name: label, exact: true }).first().click()
    await expectVisibleHeading(page, heading)
    const image = page.locator(`main img[src$="/${artwork}.webp"]`)
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
  }
  await page.goBack()
  await expectVisibleHeading(page, /Staff & Workload/)
  await page.goForward()
  await expectVisibleHeading(page, /Notifications & Account/)
  await page.goto('/returns')
  await expectVisibleHeading(page, /Returns & Quality Checks/)
  await expect(page.getByText('#ALPHA-11')).toBeVisible()
  await page.reload()
  await expectVisibleHeading(page, /Returns & Quality Checks/)
  expect(pageErrors).toEqual([])
})

test('search dialog and unassigned-store screen render through the shell', async ({ page, browser }) => {
  await installApi(page)
  await page.goto('/dashboard')
  await page.getByRole('button', { name: /Search orders by ID/ }).click()
  await expect(page.getByRole('dialog', { name: 'Store search' })).toBeVisible()

  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const unassigned = await context.newPage()
    await installApi(unassigned, { assigned: false })
    await unassigned.goto(new URL('/returns', page.url()).toString())
    await expect(unassigned.getByText('No store assigned, contact admin')).toBeVisible()
    await expect(unassigned.getByRole('heading', { name: /Returns & Quality Checks/ })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('API failures are not shown as empty applications and can be retried', async ({ page }) => {
  const api = await installApi(page, { failPath: '/v1/store/rider-applications' })
  await page.goto('/rider-applications')
  await expect(page.getByRole('alert')).toContainText('do not have access')
  await expect(page.getByText('No applications here')).toHaveCount(0)
  api.allowRequests()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expectVisibleHeading(page, /Rider Applications/)
  await expect(page.getByText('Test Rider').first()).toBeVisible()
})

test('returns failures show an error and retry the affected queries together', async ({ page }) => {
  const api = await installApi(page, { failPath: '/v1/store/returns' })
  await page.goto('/returns')
  await expect(page.getByRole('alert')).toContainText('Could not load this page')
  await expect(page.getByText('No returns awaiting recording')).toHaveCount(0)
  api.allowRequests()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expectVisibleHeading(page, /Returns & Quality Checks/)
  await expect(page.getByText('#ALPHA-11')).toBeVisible()
})

test('switching stores does not show the previous store’s returns', async ({ page }) => {
  await installApi(page, { slowStoreB: true })
  await page.goto('/returns')
  await expect(page.getByText('#ALPHA-11')).toBeVisible()
  await page.getByRole('button', { name: 'Active store' }).click()
  await page.getByRole('option', { name: /South Test Store/ }).click()
  await expect(page.getByText('#ALPHA-11')).toHaveCount(0)
  await expect(page.getByText('#BETA-99')).toBeVisible()
})

test('a failed lazy bundle shows a recovery message and another route remains usable', async ({ page }) => {
  await installApi(page)
  await page.route('**/src/pages/StoreReturns.tsx*', (route) => route.abort('failed'))
  await page.goto('/dashboard')
  await expectVisibleHeading(page, /Good .*Test/)
  await page.getByRole('link', { name: 'Returns & Quality Checks', exact: true }).first().click()
  await expect(page.getByRole('alert')).toContainText('This page could not be loaded')
  await page.getByRole('link', { name: 'Rider Applications', exact: true }).first().click()
  await expectVisibleHeading(page, /Rider Applications/)
})

test('a slow route bundle shows a loading state and then the page', async ({ page }) => {
  await installApi(page)
  let release!: () => void
  const waitForRelease = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/src/pages/StoreReturns.tsx*', async (route) => {
    await waitForRelease
    await route.continue()
  })
  await page.goto('/dashboard')
  await expectVisibleHeading(page, /Good .*Test/)
  await page.getByRole('link', { name: 'Returns & Quality Checks', exact: true }).first().click()
  try {
    await expect(page.locator('[aria-label="Loading page"]')).toBeVisible()
  } finally {
    release()
  }
  await expectVisibleHeading(page, /Returns & Quality Checks/)
})

test('an empty saved inspection draft is usable and detail failures remain visible', async ({ page }) => {
  await installApi(page)
  await page.goto('/returns')
  await page.getByRole('tab', { name: /Recorded/ }).click()
  await page.getByRole('button', { name: /Inspect return for RECORDED-1/ }).click()
  await expect(page.getByText('Inspection Notes')).toBeVisible()
  await expect(page.getByText('Loading return details…')).toHaveCount(0)

  const detailPage = await page.context().newPage()
  await installApi(detailPage, { failPath: '/v1/store/rider-applications/55555555-5555-4555-8555-555555555555' })
  await detailPage.goto(new URL('/rider-applications', page.url()).toString())
  await detailPage.getByText('Test Rider').first().click()
  await expect(detailPage.getByRole('alert')).toContainText('Could not load rider application')
  await expect(detailPage.getByText('Documents (0)')).toHaveCount(0)
  await detailPage.close()
})

test('the light sidebar remains usable when collapsed and on mobile', async ({ page }) => {
  await installApi(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/dashboard')
  await expectVisibleHeading(page, /Good .*Test/)
  const sidebar = page.locator('aside').first()
  const activeLabel = sidebar.getByRole('link', { name: 'Store Dashboard', exact: true }).locator('span').last()
  await expect(activeLabel).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(sidebar.locator('img[src$="/sidebar-farm.webp"]')).toBeVisible()
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(sidebar.locator('img[src$="/sidebar-farm.webp"]')).toBeHidden()
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Active store' })).toHaveCSS('height', '40px')
  await expect(page.getByRole('button', { name: 'Active store' }).locator('span').first()).toHaveCSS('white-space', 'nowrap')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible()
  await page.getByRole('link', { name: 'Returns & Quality Checks', exact: true }).last().click()
  await expectVisibleHeading(page, /Returns & Quality Checks/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 650 })
  await expect(sidebar.locator('img[src$="/sidebar-farm.webp"]')).toBeHidden()
})

test('the saved dark theme keeps navigation and page artwork visible', async ({ page }) => {
  await installApi(page)
  await page.addInitScript(() => localStorage.setItem('dd_store_theme', 'dark'))
  await page.goto('/rider-applications')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expectVisibleHeading(page, /Rider Applications/)
  await expect(page.locator('main img[src$="/rider-applications.webp"]')).toBeVisible()
})
