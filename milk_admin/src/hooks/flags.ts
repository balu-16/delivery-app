import { useQuery } from '@tanstack/react-query'
import { useScope } from './queries'
import { getConfig } from '@/api/settings'
import type { FeatureFlags } from '@/types'

/**
 * Feature flags come from the server config snapshot (GET /v1/admin/config →
 * flags.cod_enabled / wallet_enabled). Unknown flags
 * are not presented as enabled while the server state is unavailable.
 */
const DEFAULT_FLAGS: FeatureFlags = { cod: false, wallets: false }

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
    cod: f.cod_enabled === true,
    wallets: f.wallet_enabled === true,
  }
}

export function useFeature(flag: 'cod' | 'wallets'): boolean {
  return useFeatureFlags()[flag]
}
