/** Portal view-model contract for the dashboard, plus pure task helpers. */
export interface StoreDashboardSummary {
  storeId: string
  date: string
  openPickingTasks: number
  completedToday: number
  deadlineBreaches: number
  avgPickingTimeMin: number
  substitutedRatePct: number
  pendingRiderApps: number
  storeStatus: 'online' | 'paused'
  storeName: string
  storeCode: string
  storeNote?: string
  lowStock: Array<{ variantName: string; qty: number; reorderLevel: number }>
  expiringStock: Array<{ variantName: string; qty: number; expiryDate: string; daysLeft: number }>
  hourly: Array<{ label: string; completed: number; open: number }>
  byStatus: { waiting: number; beingPicked: number; readyToPack: number; readyHandover: number }
  staffWorkload: Array<{ id: string; name: string; activeTasks: number; level: 'High' | 'Medium' | 'Low'; status: 'active' | 'inactive' }>
  avgTasksPerActivePicker: number
  upcoming: Array<{ taskId: string; orderId: string; customerName: string; itemCount: number; dueBy: string; overdue: boolean; status: string; assigneeName: string | null }>
  overdueCount: number
  dueSoonCount: number
  lowStockCount: number
  expiringCount: number
  pendingReturns: number
  underInspection: number
  processedToday: number
  inQuarantine: number
  codTodayTotal: number
  codTodayCount: number
}

interface PickTaskLike { status: string; deadline: string }

/** True when the task is past its SLA deadline and not yet packed. */
export function isOverdue(task: PickTaskLike, now: Date): boolean {
  return (task.status === 'waiting_to_pick' || task.status === 'being_picked') &&
    new Date(task.deadline).getTime() < now.getTime()
}

/** True when the task is due within the given window (default 30 minutes). */
export function isDueSoon(task: PickTaskLike, now: Date, withinMin = 30): boolean {
  if (!(task.status === 'waiting_to_pick' || task.status === 'being_picked')) return false
  const dl = new Date(task.deadline).getTime()
  return dl > now.getTime() && dl - now.getTime() <= withinMin * 60000
}
