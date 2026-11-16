import React from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/overlays'
import { useAuth } from '@/store/auth'

/**
 * Fresh QueryClient per test (retry off for speed + determinism), MemoryRouter,
 * TooltipProvider. Optionally pre-authenticates the auth store.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions & { authenticated?: boolean; initialEntries?: string[] },
) {
  const { authenticated = false, initialEntries = ['/'], ...renderOptions } = options ?? {}
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  if (authenticated) {
    useAuth.setState({ status: 'authenticated', admin: { id: 'u-1', name: 'Arjun Mehta', email: 'admin@dairydirect.in', role: 'ADMIN' }, csrfToken: 'csrf-test-token' })
  } else {
    useAuth.setState({ status: 'authenticated', admin: null, csrfToken: null })
  }
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <TooltipProvider>{children}</TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  const result = render(ui, { wrapper: Wrapper, ...renderOptions })
  return { result, queryClient }
}
