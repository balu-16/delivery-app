import { customerRequest } from './client';

export interface ReferralView {
  enabled: boolean;
  code: string | null;
  successfulReferrals: number;
  pendingReferrals: number;
  rewardPaise: string;
  rewardExpiryMonths: number;
  freeDeliveryAvailable: boolean;
}

export type ReferralHistoryStatus = 'successful' | 'pending';

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

export interface ReferralInviteCreated {
  reference: string;
  code: string;
  createdAt: string;
}

export function shareReferralMessage(code: string): string {
  return `Join DairyDirect with my referral code ${code}. You'll get one free delivery on your next order after you sign up and verify your email.`;
}

export function shareInviteMessage(inviteCode: string): string {
  const base = `Join DairyDirect with my invite code ${inviteCode}. Sign up with this code and verify your email, and you'll get one free delivery on your next order.`;
  const signupUrl = process.env.EXPO_PUBLIC_REFERRAL_SIGNUP_URL?.trim();
  return signupUrl ? `${base} Sign up: ${signupUrl}` : base;
}

export const referralsApi = {
  view: (token: string) =>
    customerRequest<ReferralView>('/v1/customer/referrals', { token }),
  history: (token: string, status: ReferralHistoryStatus, cursor?: string, limit = 20) =>
    customerRequest<ReferralHistoryPage>(
      `/v1/customer/referrals/history?${new URLSearchParams({
        status,
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      })}`,
      { token },
    ),
  createInvite: (token: string, label: string | undefined, key: string) =>
    customerRequest<ReferralInviteCreated>('/v1/customer/referrals/invites', {
      method: 'POST',
      token,
      body: label ? { label } : {},
      idempotencyKey: key,
    }),
};
