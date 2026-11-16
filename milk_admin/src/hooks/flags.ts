import { useQuery } from '@tanstack/react-query'
import { useScope } from './queries'
import { getConfig } from '@/api/settings'
import type { FeatureFlags } from '@/types'

/**
 * Feature flags come from the server config snapshot (GET /v1/admin/config →
 * flags.cod_enabled / wallets_enabled / subscriptions_enabled). Until the
 * snapshot loads — or when the flag is absent from the payload — the flags
 * default to TRUE so sections stay visible (the backend enforces the real
 * policy on every call; the flags only hide UX affordances).
 */
const DEFAULT_FLAGS: FeatureFlags = { cod: true, wallets: true, subscriptions: true }

export function useFeatureFlags(): FeatureFlags {
  const scope = useScope()
  const { data } = useQuery({
    queryKey: ['config', scope],
    queryFn: getConfig,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  })
  if (!data?.flags) return DEFAULT_FLAGS
  const f = data.flags
  return {
    cod: f.cod_enabled !== undefined ? !!f.cod_enabled : true,
    wallets: f.wallets_enabled !== undefined ? !!f.wallets_enabled : true,
    subscriptions: f.subscriptions_enabled !== undefined ? !!f.subscriptions_enabled : true,
  }
}

export function useFeature(flag: 'cod' | 'wallets' | 'subscriptions'): boolean {
  return useFeatureFlags()[flag]
}
