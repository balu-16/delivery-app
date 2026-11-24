import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../utils'
import { requests, setRoute } from '../mockServer'
import { People } from '@/pages/People'

const DETAIL_RE = /^\/v1\/admin\/rider-applications\/(?<id>[^/]+)$/
const READ_URL_RE = /^\/v1\/admin\/rider-documents\/(?<id>[^/]+)\/read-url$/
const REVIEW_RE = /^\/v1\/admin\/rider-documents\/(?<id>[^/]+)\/review$/

function underReviewDetail() {
  return {
    userId: 'rd-app-1',
    status: 'UNDER_REVIEW',
    vehicleType: 'SCOOTER',
    vehicleNo: 'MH01AB1234',
    homeStoreId: 'st-11111111-1111-4111-8111-111111111111',
    requiredDocuments: ['licence', 'vehicle_rc', 'id_proof', 'bank_proof'],
    documents: [
      { id: 'doc-licence', type: 'licence', status: 'PENDING', reason: null, createdAt: '2026-01-20T00:00:00.000Z' },
      { id: 'doc-rc', type: 'vehicle_rc', status: 'APPROVED', reason: null, createdAt: '2026-01-20T00:00:00.000Z' },
    ],
  }
}

async function openDrawer() {
  renderWithProviders(<People />, { authenticated: true, initialEntries: ['/?tab=riders'] })
  const details = await screen.findByRole('button', { name: 'Details' })
  const user = userEvent.setup()
  await user.click(details)
  await screen.findByText('Document checklist')
}

describe('FALLBACK: People rider document review', () => {
  it('renders the per-required checklist with missing rows and decides only pending docs', async () => {
    setRoute('GET', DETAIL_RE, () => underReviewDetail())
    await openDrawer()
    expect(requests.some(({ method, path }) =>
      method === 'GET' && path === '/v1/admin/rider-applications?status=UNDER_REVIEW',
    )).toBe(true)
    // One row per required document; uploaded ones show their status.
    expect(screen.getByText('licence')).toBeInTheDocument()
    expect(screen.getByText('vehicle_rc')).toBeInTheDocument()
    expect(screen.getByText('id_proof')).toBeInTheDocument()
    expect(screen.getByText('bank_proof')).toBeInTheDocument()
    expect(screen.getAllByText('Missing')).toHaveLength(2)
    // Only the pending licence can be decided; the approved RC cannot.
    expect(screen.getAllByRole('button', { name: /Approve/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Reject/ })).toHaveLength(1)
    // No state-only hand-off note remains.
    expect(screen.queryByText(/store-manager flow/)).toBeNull()
    expect(screen.queryByText(/shows the state only/)).toBeNull()
  })

  it('shows no decision buttons for a new application that has not entered review', async () => {
    // Default mock detail: PENDING with one pending document.
    await openDrawer()
    expect(screen.getByText('license')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull()
    expect(screen.getByRole('button', { name: /View/ })).toBeInTheDocument()
  })

  it('approves a pending document and refreshes the shared application view', async () => {
    setRoute('GET', DETAIL_RE, () => underReviewDetail())
    await openDrawer()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Approve/ }))
    await waitFor(() => {
      const review = requests.find(
        (r) => r.method === 'POST' && r.path === '/v1/admin/rider-documents/doc-licence/review',
      )
      expect(review?.body).toEqual({ approved: true, reason: '' })
    })
    // Success invalidates the detail query so the drawer re-reads state.
    await waitFor(() => {
      const detailGets = requests.filter(
        (r) => r.method === 'GET' && r.path === '/v1/admin/rider-applications/rd-app-1',
      )
      expect(detailGets.length).toBeGreaterThan(1)
    })
  })

  it('rejects only with a reason', async () => {
    setRoute('GET', DETAIL_RE, () => underReviewDetail())
    await openDrawer()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Reject/ }))
    const confirm = await screen.findByRole('button', { name: /Reject document/ })
    expect(confirm).toBeDisabled()
    await user.type(
      screen.getByPlaceholderText('Why is this document being rejected?'),
      'Photo is blurry',
    )
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => {
      const review = requests.find(
        (r) => r.method === 'POST' && r.path === '/v1/admin/rider-documents/doc-licence/review',
      )
      expect(review?.body).toEqual({ approved: false, reason: 'Photo is blurry' })
    })
  })

  it('disables the decision buttons while a review is in flight', async () => {
    setRoute('GET', DETAIL_RE, () => underReviewDetail())
    let release!: () => void
    setRoute('POST', REVIEW_RE, () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode('{"reviewed":true}'))
              controller.close()
            }
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await openDrawer()
    const user = userEvent.setup()
    const approve = screen.getByRole('button', { name: /Approve/ })
    await user.click(approve)
    await waitFor(() => expect(approve).toBeDisabled())
    release()
    await waitFor(() => expect(approve).toBeEnabled())
  })

  it('refetches the application when a stale decision conflicts (409)', async () => {
    setRoute('GET', DETAIL_RE, () => underReviewDetail())
    setRoute('POST', REVIEW_RE, () => ({
      status: 409,
      body: { code: 'DOCUMENT_STATE_INVALID', detail: 'Document state changed. Reload and retry.' },
    }))
    await openDrawer()
    const before = requests.filter(
      (r) => r.method === 'GET' && r.path === '/v1/admin/rider-applications/rd-app-1',
    ).length
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Approve/ }))
    await waitFor(() => {
      const after = requests.filter(
        (r) => r.method === 'GET' && r.path === '/v1/admin/rider-applications/rd-app-1',
      ).length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('opens the preview in memory without logging or persisting the link', async () => {
    setRoute('GET', DETAIL_RE, () => underReviewDetail())
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openDrawer()
    const user = userEvent.setup()
    // First checklist row is the pending licence document.
    await user.click(screen.getAllByRole('button', { name: /View/ })[0]!)
    await waitFor(() => expect(openSpy).toHaveBeenCalled())
    expect(openSpy).toHaveBeenCalledWith(
      'https://cdn.test/rider-doc/expiring?sig=short-lived',
      '_blank',
      'noopener,noreferrer',
    )
    expect(window.localStorage.length).toBe(0)
    expect(logSpy.mock.calls.some((args) => String(args[0] ?? '').includes('short-lived'))).toBe(false)
    expect(
      requests.filter((r) => r.method === 'GET' && r.path === '/v1/admin/rider-documents/doc-licence/read-url'),
    ).toHaveLength(1)
  })
})
