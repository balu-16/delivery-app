import { get, post, buildQuery } from './http'
import { lowerStatus } from './mapping'
import type {
  AdminUser, CursorPage, RiderApplicationDetail, RiderApplicationListItem, RiderApplicationStatus, WorkforceAccount,
} from '@/types'

// ── People: users (customers + workforce) and rider applications ─────────────

interface UserRow { userId: string; email: string; name: string; pool: 'CUSTOMER' | 'WORKFORCE'; status: string; roles: string[] }

function mapUser(r: UserRow): AdminUser {
  return {
    userId: r.userId,
    email: r.email,
    name: r.name,
    pool: r.pool,
    status: lowerStatus(r.status) as AdminUser['status'],
    roles: r.roles ?? [],
  }
}

/** Identity users — pool CUSTOMER for the customers tab, WORKFORCE for staff. */
export function listUsers(opts?: { search?: string; cursor?: string; limit?: number }): Promise<CursorPage<AdminUser>> {
  const qs = buildQuery({ search: opts?.search, before: opts?.cursor, limit: opts?.limit })
  return get<{ users: UserRow[]; nextCursor: string | null }>(`/v1/admin/users${qs}`).then((res) => ({
    items: (res.users ?? []).map(mapUser),
    nextCursor: res.nextCursor ?? null,
  }))
}

function toWorkforce(u: AdminUser, storeIds: string[] = []): WorkforceAccount {
  return { userId: u.userId, email: u.email, name: u.name, status: u.status, roles: u.roles, storeIds }
}

/** Workforce view of the same listing (pool filtered server-side via search). */
export async function listWorkforce(opts?: { search?: string; cursor?: string; limit?: number }): Promise<CursorPage<WorkforceAccount>> {
  const page = await listUsers(opts)
  return { items: page.items.filter((u) => u.pool === 'WORKFORCE').map((u) => toWorkforce(u)), nextCursor: page.nextCursor }
}

// ── Workforce admin actions ──────────────────────────────────────────────────
export const createWorkforce = (input: { email: string; name: string; role: 'RIDER' | 'STORE_MANAGER' | 'SUPPORT_AGENT' }) =>
  post<{ operationId: string; userId: string }>('/v1/admin/users/workforce', input)

export const setUserBlocked = (userId: string, blocked: boolean) =>
  post<unknown>(`/v1/admin/users/${userId}/block`, { blocked })

export const requestUserPasswordReset = (userId: string) =>
  post<unknown>(`/v1/admin/users/${userId}/password-reset`, {})

export const assignUserStore = (userId: string, storeId: string, grant: boolean) =>
  post<unknown>(`/v1/admin/users/${userId}/stores/${storeId}`, { role: 'STORE_MANAGER', grant })

export const requestRoleChange = (userId: string, role: 'RIDER' | 'STORE_MANAGER' | 'SUPPORT_AGENT' | 'SUPER_ADMIN', grant: boolean) =>
  post<{ requestId: string }>(`/v1/admin/users/${userId}/roles/requests`, { role, grant })

export const approveRoleChange = (requestId: string) =>
  post<unknown>(`/v1/admin/role-change-requests/${requestId}/approve`, {})

// ── Rider applications ───────────────────────────────────────────────────────
interface ApplicationListRow { userId: string; name: string; email: string; status: string }
interface DocumentRow { id: string; type: string; status: string; reason: string | null; createdAt: string }
interface ApplicationRow {
  userId: string; status: string; vehicleType: string | null; vehicleNo: string | null
  homeStoreId: string | null; requiredDocuments: string[]; documents: DocumentRow[]
}

function mapAppStatus(s: string): RiderApplicationStatus {
  return lowerStatus(s) as RiderApplicationStatus
}

export function listRiderApplications(opts?: { status?: RiderApplicationStatus; cursor?: string; limit?: number }): Promise<CursorPage<RiderApplicationListItem>> {
  const qs = buildQuery({ status: opts?.status ? opts.status.toUpperCase() : undefined, before: opts?.cursor, limit: opts?.limit })
  return get<{ items: ApplicationListRow[]; nextCursor: string | null }>(`/v1/admin/rider-applications${qs}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({ userId: r.userId, name: r.name, email: r.email, status: mapAppStatus(r.status) })),
    nextCursor: res.nextCursor ?? null,
  }))
}

export function getRiderApplication(userId: string): Promise<RiderApplicationDetail> {
  return get<ApplicationRow>(`/v1/admin/rider-applications/${userId}`).then((r) => ({
    userId: r.userId,
    status: mapAppStatus(r.status),
    vehicleType: r.vehicleType ?? null,
    vehicleNo: r.vehicleNo ?? null,
    homeStoreId: r.homeStoreId ?? null,
    requiredDocuments: r.requiredDocuments ?? [],
    documents: (r.documents ?? []).map((d) => ({
      id: d.id,
      type: d.type,
      status: lowerStatus(d.status) as RiderApplicationDetail['documents'][number]['status'],
      reason: d.reason ?? null,
      createdAt: d.createdAt,
    })),
  }))
}
