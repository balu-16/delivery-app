import { ApiError } from './client';

/** Keep internal details out of customer copy while retaining a safe support reference. */
export function requestMessage(error: unknown, action = 'complete your request'): string {
  if (error instanceof ApiError) {
    const reference = error.traceId && /^[a-zA-Z0-9-]{1,80}$/.test(error.traceId) ? ` Reference: ${error.traceId}` : '';
    if (error.status === 401) return `Your session has expired. Sign in again and try to ${action}.${reference}`;
    if (error.status === 403) return `You do not have access to ${action}. Contact support if you need help.${reference}`;
    if (error.status === 429) return `Too many requests right now. Wait a little, then try to ${action}.${reference}`;
    if (error.code === 'ADDRESS_LOCATION_REQUIRED') return 'Confirm the location at your delivery address before ordering.';
    if (error.code === 'ADDRESS_NOT_SERVICEABLE') return 'We cannot deliver to this address right now. Try another address or contact support.';
    return `We could not ${action}. Try again, or contact support if this continues.${reference}`;
  }
  return `Could not ${action}. Check your connection and try again.`;
}
