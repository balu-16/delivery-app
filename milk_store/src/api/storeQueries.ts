/**
 * Store portal query hooks — React Query over the real /v1/store API.
 * Keys are scoped ['store', section, userId, storeId, filters] so logout and
 * store switches can clear precisely without showing a previous store's data.
 */
import { useQuery } from '@tanstack/react-query'
import { useStoreAuth, useActiveStore } from '@/login/authStore'
import * as storeApi from './storeApi'
import type { StoreDashboardSummary } from './storeSelectors'

const V = { staleTime: 10_000, gcTime: 5 * 60_000 }
// Never display the previous store's data while a newly selected store loads.
const LIST = { ...V }

/** The manager's active store id (falls back to first assignment). */
export function useActiveStoreId(): string | null {
  const user = useStoreAuth((s) => s.user)
  const activeId = useActiveStore((s) => s.activeStoreId)
  if (!user) return null
  return activeId && user.assignedStoreIds.includes(activeId) ? activeId : user.assignedStoreIds[0] ?? null
}

function scope(userId: string | undefined, storeId: string | null) {
  return { userId: userId ?? 'anon', storeId: storeId ?? 'none' }
}

// §1
export const useStoreDashboard = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'dashboard', scope(user?.id, storeId)],
    queryFn: () => storeApi.getStoreDashboardSummary(storeId!),
    enabled: !!storeId,
    ...LIST,
    staleTime: 60_000,
  })
}

// §2
export const usePickingTasks = (
  storeId: string | null,
  tab: 'queue' | 'all' | 'mine',
  filters: { status?: string; search?: string } = {},
) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'picking', scope(user?.id, storeId), tab, filters],
    queryFn: () => storeApi.listPickingTasks(storeId!, tab, user?.id ?? null, filters),
    enabled: !!storeId,
    ...LIST,
  })
}
export const usePickingTask = (id: string | null) => {
  const storeId = useActiveStoreId()
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'picking-task', scope(user?.id, storeId), id],
    queryFn: () => storeApi.getPickingTask(id!),
    enabled: !!id,
    ...V,
  })
}
export const useStoreOrders = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'orders', scope(user?.id, storeId)],
    queryFn: () => storeApi.listStoreOrders(storeId!),
    enabled: !!storeId,
    ...LIST,
  })
}

// §3
export const useStoreStock = (storeId: string | null, filters: { search?: string; status?: string } = {}) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'stock', scope(user?.id, storeId), filters],
    queryFn: () => storeApi.listStoreStock(storeId!, filters),
    enabled: !!storeId,
    ...LIST,
  })
}
export const useInventoryApprovalUnits = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'approval-threshold', scope(user?.id, storeId)],
    queryFn: () => storeApi.getInventoryApprovalUnits(storeId!),
    enabled: !!storeId,
    ...V,
  })
}
export const useLowStock = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'low-stock', scope(user?.id, storeId)],
    queryFn: () => storeApi.listLowStock(storeId!),
    enabled: !!storeId,
    ...LIST,
  })
}
export const useExpiringStock = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'expiring-stock', scope(user?.id, storeId)],
    queryFn: () => storeApi.listExpiringStock(storeId!),
    enabled: !!storeId,
    ...LIST,
  })
}
export const useStoreReceipts = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'receipts', scope(user?.id, storeId)],
    queryFn: () => storeApi.listStoreReceipts(storeId!),
    enabled: !!storeId,
    ...V,
  })
}
export const useStoreAdjustments = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'adjustments', scope(user?.id, storeId)],
    queryFn: () => storeApi.listStoreAdjustments(storeId!),
    enabled: !!storeId,
    ...V,
  })
}
export const useCountSessions = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'count-sessions', scope(user?.id, storeId)],
    queryFn: () => storeApi.listCountSessions(storeId!),
    enabled: !!storeId,
    ...V,
  })
}
export const useBinLocations = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'bins', scope(user?.id, storeId)],
    queryFn: () => storeApi.listBinLocations(storeId!),
    enabled: !!storeId,
    ...V,
  })
}

// §4
export const useEligibleReturns = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'returns-eligible', scope(user?.id, storeId)],
    queryFn: () => storeApi.listEligibleReturnOrders(storeId!),
    enabled: !!storeId,
    ...LIST,
  })
}
export const useRecordedReturns = (storeId: string | null, search = '') => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'returns-recorded', scope(user?.id, storeId), search],
    queryFn: () => storeApi.listRecordedReturns(storeId!, { search }),
    enabled: !!storeId,
    ...LIST,
  })
}
export const useReturnOrderDetail = (storeId: string | null, orderId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'return-detail', scope(user?.id, storeId), orderId],
    queryFn: () => storeApi.getReturnOrderDetail(storeId!, orderId!),
    enabled: !!storeId && !!orderId,
    ...V,
  })
}
export const useReturnDraft = (storeId: string | null, orderId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'return-draft', scope(user?.id, storeId), orderId],
    queryFn: () => storeApi.getReturnDraft(storeId!, orderId!),
    enabled: !!storeId && !!orderId,
    ...V,
  })
}

// §5
export const useRiderApplicationsStore = (storeId: string | null, status?: string, search?: string) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'rider-apps', scope(user?.id, storeId), status, search],
    queryFn: () => storeApi.listRiderApplicationsForStore(storeId!, status, search),
    enabled: !!storeId,
    ...LIST,
  })
}

// §6
export const useCodDeposits = (storeId: string | null, filters: { search?: string } = {}) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'cod', scope(user?.id, storeId), filters],
    queryFn: () => storeApi.listCodDeposits(storeId!, filters),
    enabled: !!storeId,
    ...LIST,
  })
}
export const useCodRiders = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'cod-riders', scope(user?.id, storeId)],
    queryFn: () => storeApi.listCodRiders(storeId!),
    enabled: !!storeId,
    ...V,
  })
}

// §7
export const useStoreStatusInfo = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'status-info', scope(user?.id, storeId)],
    queryFn: () => storeApi.getStoreStatusInfo(storeId!),
    enabled: !!storeId,
    ...V,
  })
}

// §8
export const useStoreStaff = (storeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'staff', scope(user?.id, storeId)],
    queryFn: () => storeApi.listStoreStaff(storeId!),
    enabled: !!storeId,
    ...V,
  })
}
export const useEligibleAssignees = (storeId: string | null, currentAssigneeId: string | null) => {
  const user = useStoreAuth((s) => s.user)
  return useQuery({
    queryKey: ['store', 'assignees', scope(user?.id, storeId), currentAssigneeId],
    queryFn: () => storeApi.listEligibleAssignees(storeId!, currentAssigneeId),
    enabled: !!storeId,
    ...V,
  })
}

// §9
export const useStoreNotifications = () => {
  const storeId = useActiveStoreId()
  const user = useStoreAuth((s) => s.user)
  const prefsQuery = useQuery({
    queryKey: ['store', 'notif-prefs', user?.id],
    queryFn: () => storeApi.getStoreNotificationPrefs(user!.id),
    enabled: !!user,
    staleTime: 5 * 60_000,
  })
  const notificationsQuery = useQuery({
    queryKey: ['store', 'notifications', scope(user?.id, storeId)],
    queryFn: () => storeApi.listStoreNotifications(storeId),
    enabled: !!user,
    ...LIST,
  })
  return {
    data: notificationsQuery.data ?? [],
    prefs: prefsQuery.data,
    isLoading: notificationsQuery.isLoading,
    notificationsQuery,
    prefsQuery,
  }
}
