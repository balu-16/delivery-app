import { ApiError } from './client';

/**
 * One shared lookup for customer-facing failure text (plan3).
 *
 * Messages are plain one-line strings. Technical details (status code,
 * server code, trace id) stay on the thrown error and are available via
 * {@link errorDiagnostic} for diagnostics / Help and support; they are
 * never appended to the message a customer reads.
 */
export function errorDiagnostic(error: unknown): string | null {
  if (error instanceof ApiError) {
    return [error.code, error.traceId].filter(Boolean).join(' ') || null;
  }
  if (error instanceof Error) return error.message || null;
  return null;
}

function couldnT(action: string): string {
  const clean = action.trim().replace(/\.*$/, '') || 'complete your request';
  return `Couldn’t ${clean}.`;
}

/** Map any failure to its one-line customer message. */
export function customerErrorMessage(error: unknown, action = 'complete your request'): string {
  // Auth failures (Cognito codes) — stable codes, plain text.
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'AuthError') {
    const code = (error as { code?: unknown }).code;
    switch (code) {
      case 'INVALID_CREDENTIALS': return 'Email or password is incorrect.';
      case 'EXPIRED_CODE': return 'Request a new verification code.';
      case 'INVALID_CODE': return 'That code is incorrect.';
      case 'EMAIL_NOT_VERIFIED': return 'Verify your email before signing in.';
      case 'ACCOUNT_EXISTS': return 'An account already exists for this email.';
      case 'INVALID_PASSWORD': return 'This password does not meet the account requirements.';
      case 'RATE_LIMITED': return 'Too many attempts. Wait a few minutes and try again.';
      case 'RESET_REQUIRED': return 'A password reset is required for this account.';
      case 'CHALLENGE_EXPIRED': return 'Sign in again to continue.';
      case 'COGNITO_UNREACHABLE': return 'Cannot reach the sign-in service.';
      case 'COGNITO_UNAVAILABLE': return 'The sign-in service is unavailable right now.';
      case 'AUTH_CONFIGURATION': return 'Sign-in is not available right now.';
      case 'BACKEND_UNREACHABLE': return 'Cannot reach the customer server.';
      case 'BACKEND_CONFIGURATION': return 'Sign-in is not available right now.';
      case 'BACKEND_DISCOVERY': return 'Cannot find the customer server.';
      case 'UNSUPPORTED_CHALLENGE': return 'This account needs extra verification.';
      case 'MISSING_ATTRIBUTE': return 'Fill in the required account details.';
      case 'GROUP_PENDING': return 'Your account is still being set up.';
      default: return couldnT(action);
    }
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_CREDENTIALS': return 'Email or password is incorrect.';
      case 'SESSION_EXPIRED': return 'Sign in again to continue.';
      case 'EXPIRED_CODE': return 'Request a new verification code.';
      case 'PRICE_CHANGED': return 'Price changed. Review your cart.';
      case 'ADDRESS_NOT_SERVICEABLE': return 'Delivery isn’t available here.';
      case 'CUTOFF_PASSED': return 'The change deadline has passed.';
      case 'AGENT_DAILY_LIMIT': return 'Daily limit reached. Resets at 12 AM IST.';
      case 'RATE_LIMITED': return 'Too many requests right now.';
      case 'ADDRESS_LOCATION_REQUIRED': return 'Confirm the location at your delivery address.';
      case 'ADDRESS_REQUIRED': return 'Choose a delivery address.';
      case 'QUOTE_EXPIRED': return 'Your order summary expired. Review it again.';
      case 'QUOTE_CONSUMED':
      case 'CART_INTENT_CONSUMED': return 'This checkout was already used. Check My Dairy for your order.';
      case 'INVENTORY_INSUFFICIENT':
      case 'ITEM_UNAVAILABLE': return 'This item is no longer available.';
      case 'CART_NOT_FOUND': return 'Your cart is empty.';
      case 'CONCURRENT_MODIFICATION': return 'Your cart changed. Review your cart.';
      case 'IDEMPOTENCY_LEASE_LOST':
      case 'REQUEST_IN_PROGRESS':
      case 'RUN_IN_PROGRESS': return 'Your request is still being checked.';
      case 'COD_NOT_ELIGIBLE':
      case 'COD_LIMIT_EXCEEDED': return 'Cash on delivery is not available for this order.';
      case 'WALLET_INSUFFICIENT':
      case 'WALLET_DISABLED': return 'Your wallet availability changed. Review your order.';
      case 'SUBSCRIPTION_STATE_INVALID': return 'This subscription can no longer be changed.';
    }
    if (error.status === 401) return 'Sign in again to continue.';
    if (error.status === 403) return 'You don’t have access to this.';
    if (error.status === 429) return 'Too many requests right now.';
    return couldnT(action);
  }
  if (error instanceof TypeError) return couldnT(action);
  if (error instanceof Error && error.name === 'AbortError') return couldnT(action);
  return couldnT(action);
}

/** Assistant run-event codes use the same one-line lookup as HTTP failures. */
export function agentRunErrorMessage(code: string, action = 'complete your request'): string {
  switch (code) {
    case 'AGENT_DAILY_LIMIT': return 'Daily limit reached. Resets at 12 AM IST.';
    case 'RATE_LIMITED': return 'Too many requests right now.';
    case 'DRAFT_PENDING': return 'Confirm or cancel the pending action first.';
    case 'RUN_IN_PROGRESS': return 'Your request is still being checked.';
    default: return agentErrorFallback(action);
  }
}

function agentErrorFallback(action: string): string {
  return couldnT(action === 'complete your request' ? 'complete your request' : action);
}

// Back-compat name used across the app; still one lookup, no references.
export const requestMessage = customerErrorMessage;
