import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataTable } from '@/components/shared/DataTable'
import Dashboard from '@/pages/Dashboard'
import { renderWithProviders } from '../utils'

describe('loading feedback', () => {
  it('shows dashboard skeletons before the first metrics response', async () => {
    renderWithProviders(<Dashboard />)
    expect(screen.getByRole('status', { name: 'Loading dashboard' })).toBeInTheDocument()
    expect(screen.queryByText('Orders placed')).not.toBeInTheDocument()
    expect(await screen.findByText('Orders placed')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading dashboard' })).not.toBeInTheDocument()
  })

  it('distinguishes loading, failed and empty tables and retries a failure', () => {
    const retry = vi.fn()
    const props = { columns: [{ key: 'name', header: 'Name' }], rows: [] as { id: string; name: string }[], keyId: (row: { id: string }) => row.id, onRetry: retry }
    const view = render(<DataTable {...props} loading />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading data')
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument()
    view.rerender(<DataTable {...props} error />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this data')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
    view.rerender(<DataTable {...props} />)
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
  })
})
