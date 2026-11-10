import type {
  PushPayload,
  PushPort,
  PushTokenResult,
} from '../../modules/notifications/contracts/notifications.js';

export interface RecordedPush {
  tokens: string[];
  payload: PushPayload;
}

/**
 * In-memory fake for tests/local: per-token scripted outcomes plus batched
 * transport failures. Contract-compatible with FcmPush results ordering.
 */
export class FakePush implements PushPort {
  readonly sent: RecordedPush[] = [];
  /** Per-token results; unlisted tokens succeed with a synthetic message id. */
  readonly outcomes = new Map<string, PushTokenResult>();
  /** Number of upcoming send() calls that throw before succeeding again. */
  failNext = 0;
  async send(tokens: readonly string[], payload: PushPayload): Promise<PushTokenResult[]> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('ExternalServiceUnavailable');
    }
    this.sent.push({ tokens: [...tokens], payload });
    return tokens.map(
      (token) =>
        this.outcomes.get(token) ?? {
          token,
          ok: true,
          invalidToken: false,
          messageId: `fake-push-${this.sent.length}-${token.slice(0, 6)}`,
          error: null,
        },
    );
  }
  scriptInvalid(token: string): void {
    this.outcomes.set(token, {
      token,
      ok: false,
      invalidToken: true,
      messageId: null,
      error: 'messaging/registration-token-not-registered',
    });
  }
  allTokens(): string[] {
    return this.sent.flatMap((entry) => entry.tokens);
  }
}
