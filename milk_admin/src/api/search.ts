import { get, buildQuery } from './http'
import type { SearchGroup } from '@/types'

// ── Global search — pinned new endpoint GET /v1/admin/search ─────────────────

export function globalSearch(q: string, limit = 20): Promise<SearchGroup[]> {
  if (!q.trim()) return Promise.resolve([])
  return get<{ groups: SearchGroup[] }>(`/v1/admin/search${buildQuery({ q: q.trim(), limit })}`).then((res) => res.groups ?? [])
}
