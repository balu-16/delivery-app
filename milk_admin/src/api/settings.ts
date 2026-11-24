import { get, patch, post } from './http'
import type { ConfigSnapshot, ConfigChange, ConfigChangeResult } from '@/types'

// ── Settings: server config snapshot + config keys + feature flags ───────────

export function getConfig(): Promise<ConfigSnapshot> {
  return get<{
    config: Record<string, unknown>
    flags: Record<string, boolean>
    configRevisions?: Record<string, string>
    flagRevisions?: Record<string, string>
  }>('/v1/admin/config').then((res) => ({
    config: res.config ?? {},
    flags: res.flags ?? {},
    configRevisions: res.configRevisions ?? {},
    flagRevisions: res.flagRevisions ?? {},
  }))
}

/** Update a typed configuration value (409 on conflicts surfaces verbatim). */
export const updateConfigKey = (key: string, value: unknown, expectedVersion?: string) =>
  post<null>(`/v1/admin/config/${encodeURIComponent(key)}`, { value, ...(expectedVersion !== undefined ? { expectedVersion } : {}) })

/** Atomic batch write; returns new values + revisions (409 on stale revision). */
export const batchUpdateConfig = (changes: ConfigChange[]) =>
  patch<{ updated: ConfigChangeResult[] }>('/v1/admin/config', { changes })

export const updateFeatureFlag = (key: string, enabled: boolean, expectedVersion?: string) =>
  post<null>(`/v1/admin/feature-flags/${encodeURIComponent(key)}`, {
    enabled,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  })
