import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'

// Silence React's error-boundary logging for the deliberate crash below.
vi.spyOn(console, 'error').mockImplementation(() => {})

function Bomb({ crash }: { crash: boolean }) {
  if (crash) throw new Error('exploded on purpose')
  return <p>all good</p>
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders children normally when nothing throws', () => {
    render(<ErrorBoundary><Bomb crash={false} /></ErrorBoundary>)
    expect(screen.getByText('all good')).toBeTruthy()
  })

  it('shows the recoverable fallback (never a blank page) when a child crashes', () => {
    render(<ErrorBoundary><Bomb crash /></ErrorBoundary>)
    expect(screen.getByText('This section hit a snag')).toBeTruthy()
    expect(screen.getByText(/exploded on purpose/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy()
  })

  it('recovers via the Try again button once the underlying issue resolves', () => {
    // Mutable crash source mirrors reality: "Try again" re-renders the same
    // children — recovery only sticks when the cause is gone (transient error).
    const source = { crash: true }
    function MaybeBomb({ s }: { s: { crash: boolean } }) {
      if (s.crash) throw new Error('exploded on purpose')
      return <p>all good</p>
    }
    render(<ErrorBoundary><MaybeBomb s={source} /></ErrorBoundary>)
    expect(screen.getByText('This section hit a snag')).toBeTruthy()
    source.crash = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('all good')).toBeTruthy()
  })

  it('resets when the route changes (resetKey)', () => {
    const { rerender } = render(<ErrorBoundary resetKey="/products"><Bomb crash /></ErrorBoundary>)
    expect(screen.getByText('This section hit a snag')).toBeTruthy()
    rerender(<ErrorBoundary resetKey="/orders"><Bomb crash={false} /></ErrorBoundary>)
    expect(screen.getByText('all good')).toBeTruthy()
  })
})
