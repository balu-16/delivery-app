import { get, post } from './http'
import type { AuthAdmin } from '@/types'

// ── Auth endpoints (pinned contract) ─────────────────────────────────────────

export interface AuthenticatedResponse {
  status: 'AUTHENTICATED'
  admin: AuthAdmin
  csrfToken: string
}

export interface ChallengeResponse {
  status: 'CHALLENGE'
  challenge: 'NEW_PASSWORD_REQUIRED'
  challengeId: string
}

export type LoginResponse = AuthenticatedResponse | ChallengeResponse

export function login(email: string, password: string): Promise<LoginResponse> {
  return post<LoginResponse>('/v1/admin/auth/login', { email, password }, {})
}

export function challenge(challengeId: string, newPassword: string): Promise<AuthenticatedResponse> {
  return post<AuthenticatedResponse>('/v1/admin/auth/challenge', { challengeId, newPassword })
}

export function forgotPassword(email: string): Promise<{ status: 'SENT' }> {
  return post<{ status: 'SENT' }>('/v1/admin/auth/forgot-password', { email })
}

export function confirmReset(email: string, confirmationCode: string, newPassword: string): Promise<{ status: 'RESET' }> {
  return post<{ status: 'RESET' }>('/v1/admin/auth/forgot-password/confirm', { email, confirmationCode, newPassword })
}

export interface SessionResponse {
  admin: AuthAdmin
  csrfToken: string
}

export function getSession(): Promise<SessionResponse> {
  return get<SessionResponse>('/v1/admin/auth/session')
}

export function logout(allSessions?: boolean): Promise<{ status: 'LOGGED_OUT' }> {
  return post<{ status: 'LOGGED_OUT' }>('/v1/admin/auth/logout', { allSessions })
}
