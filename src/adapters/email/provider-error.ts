/** Typed provider failures; messages never carry vendor or PII detail. */
export class SendProviderError extends Error {
  constructor(
    readonly code:
      'ExternalServiceUnavailable' | 'ExternalServiceTimeout' | 'ExternalServiceRejected',
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

/** Transport-style failures (network, timeouts, 5xx) are retryable. */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof SendProviderError && error.code !== 'ExternalServiceRejected';
}
