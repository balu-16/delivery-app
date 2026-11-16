import { QueryClient } from '@tanstack/react-query'

/**
 * Shared QueryClient — lets the sidebar prefetch and mutations share the cache.
 * Retry policy: transient failures only (5xx / network); 4xx answers are
 * authoritative and must surface immediately, never retry silently.
 */
function isTransient(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status ?? 0
  return status === 0 || status >= 500
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => isTransient(error) && failureCount < 2,
      retryDelay: (attempt) => Math.min(4000, 500 * 2 ** attempt),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 10 * 60_000,
    },
    mutations: {
      retry: 0,
    },
  },
})
