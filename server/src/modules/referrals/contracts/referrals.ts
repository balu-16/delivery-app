import type { TransactionContext } from '../../../platform/database/database.js';
export const REFERRALS = Symbol('REFERRALS');

/** Current reward rules (plan3 §6): promo credit only, 1-month IST expiry. */
export const REFERRAL_REWARD_PAIRSE = '1000';
export const REFERRAL_HISTORY_DEFAULT_LIMIT = 20;
export const REFERRAL_HISTORY_MAX_LIMIT = 50;
export const REFERRAL_INVITE_LABEL_MAX = 48;
export const REFERRAL_INVITE_RATE_LIMIT_PER_HOUR = 20;

/** Frozen grammar (plan3 §6, lead contract): reusable `^[A-F0-9]{16}$`, tracked `INV-` + 32 hex. */
export const REUSABLE_REFERRAL_CODE = /^[A-F0-9]{16}$/;
export const TRACKED_INVITE_CODE = /^INV-[A-F0-9]{32}$/;
export const REFERRAL_CODE = /^(?:[A-F0-9]{16}|INV-[A-F0-9]{32})$/;

/** Normalize case and surrounding whitespace at entry; never store/return the raw input. */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}
export function isReusableReferralCode(normalized: string): boolean {
  return REUSABLE_REFERRAL_CODE.test(normalized);
}
export function isTrackedInviteCode(normalized: string): boolean {
  return TRACKED_INVITE_CODE.test(normalized);
}

/** Trim owner label; empty becomes null. Throws INVALID_INPUT when over 48 chars. */
export function normalizeInviteLabel(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > REFERRAL_INVITE_LABEL_MAX) throw new Error('INVALID_INPUT');
  return trimmed;
}

export interface ReferralView {
  enabled: boolean;
  code: string | null;
  successfulReferrals: number;
  /** Same verified caller; independent of history page length. */
  pendingReferrals: number;
  rewardPaise: string;
  /** Calendar months the current reward stays valid (India time). */
  rewardExpiryMonths: number;
  freeDeliveryAvailable: boolean;
}

export type ReferralHistoryStatus = 'successful' | 'pending';

/**
 * Owner-scoped projection (plan3 §6): opaque id, owner label, status, createdAt.
 * Successful adds completedAt/rewardPaise/creditExpiresAt; pending adds inviteCode.
 * Never carries recipient names, email, phone, account IDs, addresses,
 * verification details, or order activity.
 */
export interface ReferralHistoryItem {
  id: string;
  label: string | null;
  status: ReferralHistoryStatus;
  createdAt: string;
  completedAt?: string;
  rewardPaise?: string;
  creditExpiresAt?: string;
  inviteCode?: string;
}
export interface ReferralHistoryPage {
  items: ReferralHistoryItem[];
  nextCursor: string | null;
}

/** 201 body: opaque reference (invite id), one-use code, creation date. */
export interface ReferralInviteCreated {
  reference: string;
  code: string;
  createdAt: string;
}

/**
 * Opaque history cursor: base64url(JSON {v,s,u,t,id}) bound to filter + account.
 * `t` keeps database timestamp precision; `id` is the paging key (claim id for
 * successful, invite id for pending) and may differ from the returned opaque id
 * for invite-backed successes (invite id).
 */
function encodeHistoryCursor(
  status: ReferralHistoryStatus,
  userId: string,
  timestamp: string,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, s: status, u: userId, t: timestamp, id }),
    'utf8',
  ).toString('base64url');
}
function decodeHistoryCursor(
  cursor: string,
  status: ReferralHistoryStatus,
  userId: string,
): { timestamp: string; id: string } {
  let parsed: { v?: unknown; s?: unknown; u?: unknown; t?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    throw new Error('INVALID_PAGE');
  }
  if (
    parsed?.v !== 1 ||
    parsed?.s !== status ||
    parsed?.u !== userId ||
    typeof parsed?.t !== 'string' ||
    typeof parsed?.id !== 'string' ||
    Number.isNaN(new Date(parsed.t).getTime()) ||
    !/^[0-9a-f-]{36}$/i.test(parsed.id)
  )
    throw new Error('INVALID_PAGE');
  return { timestamp: parsed.t, id: parsed.id };
}

export const historyCursor = { encode: encodeHistoryCursor, decode: decodeHistoryCursor };

export interface Referrals {
  view(userId: string): Promise<ReferralView>;
  claimForNewCustomer(code: string, friendId: string, tx: TransactionContext): Promise<void>;
  history(
    userId: string,
    status: ReferralHistoryStatus,
    cursor?: string,
    limit?: number,
  ): Promise<ReferralHistoryPage>;
  createInvite(
    userId: string,
    label: string | undefined,
    tx: TransactionContext,
  ): Promise<ReferralInviteCreated>;
}
