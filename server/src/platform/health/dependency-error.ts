const safeCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'AbortError',
  'TimeoutError',
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'AccessDenied',
  'AccessDeniedException',
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'RequestThrottled',
  'ReceiptHandleIsInvalid',
]);

/** Keep infrastructure diagnostics free of URLs, command arguments and credentials. */
export function dependencyErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN';
  for (const value of [
    'code' in error ? error.code : undefined,
    'Code' in error ? error.Code : undefined,
    error.name,
  ]) {
    if (
      typeof value === 'string' &&
      (safeCodes.has(value) || ('severity' in error && /^[0-9A-Z]{5}$/.test(value)))
    )
      return value;
  }
  const redisCode =
    /^(NOAUTH|WRONGPASS|NOPERM|CROSSSLOT|READONLY|MOVED|CLUSTERDOWN|LOADING)\b/.exec(
      error.message,
    )?.[1];
  if (redisCode) return redisCode;
  if (/^ERR unknown command\b/i.test(error.message)) return 'REDIS_UNKNOWN_COMMAND';
  if (/^(Command timed out|Connection timeout|timeout expired)$/.test(error.message))
    return 'TIMEOUT';
  return 'UNKNOWN';
}
