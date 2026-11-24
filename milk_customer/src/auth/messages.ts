import { ApiError } from '../api/client';
import { AuthError } from './cognito';
import { customerErrorMessage } from '../api/messages';

export function authErrorMessage(cause: unknown): string {
  if (cause instanceof AuthError || (cause as { name?: unknown })?.name === 'AuthError') {
    return customerErrorMessage(cause);
  }
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case 'INVALID_REFERRAL_CODE':
      case 'REFERRAL_SIGNUP_ONLY':
        return 'This referral code cannot be applied.';
      case 'REFERRAL_INVITE_USED':
        return 'That invite has already been used. Check the code or sign in without a referral.';
      case 'REFERRAL_UNAVAILABLE':
      case 'REFERRALS_UNAVAILABLE':
        return 'Referral rewards are unavailable right now.';
      case 'EMAIL_NOT_VERIFIED': return 'Verify your email before signing in.';
      case 'ACCOUNT_DISABLED': return 'This account is unavailable.';
      case 'ROLE_CONFLICT': return 'This account is registered for a different app.';
    }
    return customerErrorMessage(cause, 'finish setting up your account');
  }
  if (cause instanceof Error && cause.message.startsWith('Enter a valid')) return cause.message;
  return customerErrorMessage(cause);
}

export function isReferralError(cause: unknown): boolean {
  return cause instanceof ApiError && ['INVALID_REFERRAL_CODE', 'REFERRAL_SIGNUP_ONLY', 'REFERRAL_INVITE_USED', 'REFERRAL_UNAVAILABLE', 'REFERRALS_UNAVAILABLE'].includes(cause.code);
}
