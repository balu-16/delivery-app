import { get, post } from './http'
import type { ConfigSnapshot } from '@/types'

// ── Settings: server config snapshot + config keys + feature flags ───────────

export function getConfig(): Promise<ConfigSnapshot> {
  return get<{ config: Record<string, unknown>; flags: Record<string, boolean> }>('/v1/admin/config').then((res) => ({
    config: res.config ?? {},
    flags: res.flags ?? {},
  }))
}

/** Update a typed configuration value (409 on conflicts surfaces verbatim). */
export const updateConfigKey = (key: string, value: unknown) =>
  post<null>(`/v1/admin/config/${encodeURIComponent(key)}`, { value })

export const updateFeatureFlag = (key: string, enabled: boolean) =>
  post<null>(`/v1/admin/feature-flags/${encodeURIComponent(key)}`, { enabled })
