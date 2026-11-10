import {
  IdentityProviderError,
  type IdentityAdminPort,
  type Role,
} from '../../modules/identity/contracts/identity.js';
/** Short timeouts belong to the underlying provider; the breaker bounds repeated outages. */
export class ResilientIdentityAdmin implements IdentityAdminPort {
  private failures = 0;
  private retryAt = 0;
  private probing = false;
  constructor(
    private readonly inner: IdentityAdminPort,
    private readonly threshold = 5,
    private readonly cooldownMs = 30000,
    private readonly now: () => number = Date.now,
  ) {}
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.now() < this.retryAt) throw new IdentityProviderError('ExternalServiceUnavailable');
    const probe = this.failures >= this.threshold;
    if (probe && this.probing) throw new IdentityProviderError('ExternalServiceUnavailable');
    if (probe) this.probing = true;
    try {
      const result = await operation();
      this.failures = 0;
      this.retryAt = 0;
      return result;
    } catch (cause: unknown) {
      const name = cause instanceof Error ? cause.name : '';
      const status =
        typeof cause === 'object' &&
        cause !== null &&
        '$metadata' in cause &&
        typeof cause.$metadata === 'object' &&
        cause.$metadata !== null &&
        'httpStatusCode' in cause.$metadata
          ? cause.$metadata.httpStatusCode
          : undefined;
      const rejected =
        typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      const code = rejected
        ? 'ExternalServiceRejected'
        : name === 'AbortError' || name === 'TimeoutError'
          ? 'ExternalServiceTimeout'
          : 'ExternalServiceUnavailable';
      if (rejected) {
        this.failures = 0;
        this.retryAt = 0;
      } else if (++this.failures >= this.threshold) this.retryAt = this.now() + this.cooldownMs;
      throw new IdentityProviderError(code, cause);
    } finally {
      if (probe) this.probing = false;
    }
  }
  create(username: string, email: string, name: string) {
    return this.call(() => this.inner.create(username, email, name));
  }
  find(username: string) {
    return this.call(() => this.inner.find(username));
  }
  addToGroup(username: string, group: Role) {
    return this.call(() => this.inner.addToGroup(username, group));
  }
  removeFromGroup(username: string, group: Role) {
    return this.call(() => this.inner.removeFromGroup(username, group));
  }
  enable(username: string) {
    return this.call(() => this.inner.enable(username));
  }
  delete(username: string) {
    return this.call(() => this.inner.delete(username));
  }
  disable(username: string) {
    return this.call(() => this.inner.disable(username));
  }
  forcePasswordReset(username: string) {
    return this.call(() => this.inner.forcePasswordReset(username));
  }
}
