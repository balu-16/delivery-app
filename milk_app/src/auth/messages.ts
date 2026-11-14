import { ApiError } from '../api/client';
import { AuthError } from './cognito';

export function authErrorMessage(cause: unknown): string {
  if (cause instanceof AuthError) return cause.message;
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case 'INVALID_REFERRAL_CODE':
      case 'REFERRAL_SIGNUP_ONLY':
        return 'This referral code cannot be applied to this account. Check the code or continue without it.';
      case 'REFERRAL_UNAVAILABLE':
      case 'REFERRALS_UNAVAILABLE':
        return 'Referral rewards are temporarily unavailable. Try later or continue without the referral.';
      case 'EMAIL_NOT_VERIFIED': return 'Verify your email before signing in.';
      case 'ACCOUNT_DISABLED': return 'This account is unavailable. Please contact support.';
      case 'ROLE_CONFLICT': return 'This account is registered for a different app. Use a separate customer account to order.';
    }
    if (cause.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    if (cause.status === 401 || cause.status === 403) return 'The customer server could not verify your sign-in. Please try again or contact support.';
    if (cause.status >= 500) return 'The customer server is temporarily unavailable. Please try again shortly.';
    return 'The customer server could not finish setting up your account. Please check your details or contact support.';
  }
  if (cause instanceof Error && cause.message.startsWith('Enter a valid 16-character')) return cause.message;
  return 'We could not complete this request. Please try again or contact support.';
}

export function isReferralError(cause: unknown): boolean {
  return cause instanceof ApiError && ['INVALID_REFERRAL_CODE', 'REFERRAL_SIGNUP_ONLY', 'REFERRAL_UNAVAILABLE', 'REFERRALS_UNAVAILABLE'].includes(cause.code);
}
