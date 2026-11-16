import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/http'

/**
 * Shared QueryClient — lets the sidebar prefetch and mutations share the cache.
 * In-memory only (cookie auth): nothing about the session or query data is
 * ever persisted to web storage.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Transient infrastructure failures (5xx, network) retry briefly; client
      // errors (4xx) surface immediately — retrying them is pointless noise.
      retry: (failureCount, error) => {
        if (error instanceof ApiError) return error.status >= 500 && failureCount < 2
        return failureCount < 2
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 10 * 60_000,
    },
    mutations: {
      // Mutations are user intents — a failed one must never auto-fire twice.
      retry: false,
    },
  },
})
