import { createHash, randomBytes } from 'node:crypto';
import { readEnv } from '../../../src/config/env.schema.js';
import { ConfigService } from '../../../src/config/config.service.js';
import {
  AdminSessionStore,
  csrfTokenHash,
  csrfTokenMatches,
  openSessionTokens,
  sealSessionTokens,
} from '../../../src/modules/identity/infrastructure/admin-sessions.js';
import {
  AdminAuthProviderError,
  type AdminChallengeState,
  type AdminSessions,
} from '../../../src/modules/identity/contracts/admin-auth.js';
import { CognitoAdminAuth } from '../../../src/adapters/auth/cognito-admin-auth.js';

const payload = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresIn: 3600,
  csrfToken: 'csrf-token-value',
};

describe('admin session token sealing', () => {
  const key = Buffer.alloc(32, 3);
  it('round-trips tokens under the version prefix', () => {
    const sealed = sealSessionTokens(payload, key, 2);
    expect(sealed[0]!).toBe(2);
    const opened = openSessionTokens(sealed, (version) => (version === 2 ? key : undefined));
    expect(opened).toEqual(payload);
  });
  it('rejects a wrong key and tampered ciphertext as dead sessions', () => {
    const sealed = sealSessionTokens(payload, key, 1);
    expect(() => openSessionTokens(sealed, () => Buffer.alloc(32, 9))).toThrow('SESSION_EXPIRED');
    const corrupted = Buffer.from(sealed);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    expect(() => openSessionTokens(corrupted, () => key)).toThrow('SESSION_EXPIRED');
  });
  it('refuses truncated and unknown-version payloads', () => {
    expect(() => openSessionTokens(Buffer.from('short'), () => key)).toThrow('SESSION_EXPIRED');
    const sealed = sealSessionTokens(payload, key, 1);
    expect(() => openSessionTokens(sealed, () => undefined)).toThrow('SESSION_EXPIRED');
  });
  it('hashes CSRF tokens without storing the raw value', () => {
    const hash = csrfTokenHash('presented-token');
    expect(hash).toBe(createHash('sha256').update('presented-token', 'utf8').digest('hex'));
    expect(csrfTokenMatches('presented-token', hash)).toBe(true);
    expect(csrfTokenMatches('another-token', hash)).toBe(false);
    expect(csrfTokenMatches('', hash)).toBe(false);
  });
});

describe('admin session challenge store', () => {
  function fakeRedis() {
    const entries = new Map<string, { value: string; expiresAt: number }>();
    return {
      calls: [] as string[][],
      async set(key: string, value: string, mode: string, ttl: number) {
        this.calls.push(['set', key, mode, String(ttl)]);
        entries.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      },
      async getdel(key: string) {
        const entry = entries.get(key);
        entries.delete(key);
        return entry && entry.expiresAt > Date.now() ? entry.value : null;
      },
    };
  }
  function store(redis: ReturnType<typeof fakeRedis>): AdminSessions {
    const config = new ConfigService(
      readEnv({
        ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
      }),
    );
    return new AdminSessionStore({} as never, redis as never, config) as unknown as AdminSessions;
  }
  it('stores challenges with the documented key and 300s TTL and consumes them once', async () => {
    const redis = fakeRedis();
    const sessions = store(redis);
    const challenge: AdminChallengeState = {
      pool: 'WORKFORCE',
      username: 'admin@example.test',
      providerSession: 'provider-session-string',
    };
    const challengeId = randomBytes(16).toString('hex');
    await sessions.putChallenge(challengeId, challenge);
    expect(redis.calls[0]).toEqual(['set', `admin:auth:challenge:${challengeId}`, 'EX', '300']);
    expect(await sessions.takeChallenge(challengeId)).toEqual(challenge);
    expect(await sessions.takeChallenge(challengeId)).toBeNull();
  });
  it('rejects malformed challenge ids and malformed stored payloads', async () => {
    const redis = fakeRedis();
    const sessions = store(redis);
    await expect(
      sessions.putChallenge('not-hex', {
        pool: 'WORKFORCE',
        username: 'x',
        providerSession: 'y',
      }),
    ).rejects.toThrow('CHALLENGE_ID_INVALID');
    await expect(sessions.takeChallenge('zz')).resolves.toBeNull();
    await redis.set(
      'admin:auth:challenge:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      JSON.stringify({ pool: 'CUSTOMER' }),
      'EX',
      300,
    );
    await expect(sessions.takeChallenge('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).resolves.toBeNull();
  });
});

class StubCognitoClient {
  constructor(private readonly respond: () => unknown) {}
  async send(_command: unknown): Promise<unknown> {
    const result = this.respond();
    if (result instanceof Error) throw result;
    return result;
  }
}

describe('cognito admin auth error mapping', () => {
  function provider(respond: () => unknown): CognitoAdminAuth {
    return new CognitoAdminAuth(new StubCognitoClient(respond) as never, 'pool', 'client', 1000);
  }
  it('maps wrong-password and unknown-user login failures to the same generic rejection', async () => {
    for (const name of ['NotAuthorizedException', 'UserNotFoundException']) {
      let caught: unknown;
      try {
        await provider(() => Object.assign(new Error(name), { name })).passwordLogin(
          'admin@example.test',
          'secret',
        );
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdminAuthProviderError);
      expect((caught as AdminAuthProviderError).kind).toBe(
        name === 'UserNotFoundException' ? 'invalid_credentials' : 'invalid_credentials',
      );
    }
  });
  it('keeps the bounded union for challenges, policy rejections and outages', async () => {
    const challenge = provider(() =>
      Object.assign(new Error('ExpiredCodeException'), { name: 'ExpiredCodeException' }),
    );
    await expect(challenge.respondToChallenge('session', 'NewPassword1')).rejects.toMatchObject({
      kind: 'challenge_required',
    });
    const policy = provider(() =>
      Object.assign(new Error('InvalidPasswordException'), { name: 'InvalidPasswordException' }),
    );
    await expect(policy.respondToChallenge('session', 'weak')).rejects.toMatchObject({
      kind: 'policy_violation',
    });
    const outage = provider(() =>
      Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' }),
    );
    await expect(outage.passwordLogin('a@b.test', 'x')).rejects.toMatchObject({
      kind: 'provider_unavailable',
    });
    const throttled = provider(() =>
      Object.assign(new Error('TooManyRequestsException'), { name: 'TooManyRequestsException' }),
    );
    await expect(throttled.passwordLogin('a@b.test', 'x')).rejects.toMatchObject({
      kind: 'provider_unavailable',
    });
  });
  it('reports authentication results and NEW_PASSWORD_REQUIRED challenges', async () => {
    const ok = provider(() => ({
      AuthenticationResult: {
        AccessToken: 'access',
        RefreshToken: 'refresh',
        ExpiresIn: 3600,
      },
    }));
    await expect(ok.passwordLogin('a@b.test', 'x')).resolves.toEqual({
      status: 'AUTHENTICATED',
      tokens: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 },
    });
    const challenge = provider(() => ({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: 'provider-session',
    }));
    await expect(challenge.passwordLogin('a@b.test', 'x')).resolves.toEqual({
      status: 'CHALLENGE',
      challenge: 'NEW_PASSWORD_REQUIRED',
      providerSession: 'provider-session',
    });
  });
});

describe('admin session environment', () => {
  const key32 = Buffer.alloc(32, 5).toString('base64');
  it('accepts an empty ring outside production and requires it in production', () => {
    expect(readEnv({}).ADMIN_SESSION_KEYS_JSON).toBe('{}');
    const production = readEnv({
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'cognito',
      PAYMENTS_PROVIDER: 'razorpay',
      MAPS_PROVIDER: 'ola',
      STORAGE_PROVIDER: 's3',
      EMAIL_PROVIDER: 'ses',
      PUSH_PROVIDER: 'fcm',
      APP_BASE_URL: 'https://api.example.com',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      DATABASE_URL: 'postgres://user:secret@db.example.com:5432/app',
      REDIS_URL: 'rediss://redis.example.com:6379',
      COGNITO_CUSTOMER_POOL_ID: 'customer',
      COGNITO_CUSTOMER_CLIENT_ID: 'customer-client',
      COGNITO_WORKFORCE_POOL_ID: 'workforce',
      COGNITO_RIDER_CLIENT_ID: 'rider',
      COGNITO_STORE_CLIENT_ID: 'store',
      COGNITO_ADMIN_CLIENT_ID: 'admin',
      S3_MEDIA_BUCKET: 'media-bucket',
      S3_PRIVATE_BUCKET: 'private-bucket',
      CDN_BASE_URL: 'https://cdn.example.com',
      SES_FROM_ADDRESS: 'sender@example.com',
      FCM_SERVICE_ACCOUNT_JSON_SECRET: 'managed-secret-ref',
      RAZORPAY_KEY_ID: 'rzp_live_example',
      RAZORPAY_KEY_SECRET: 'gateway-secret',
      RAZORPAY_WEBHOOK_SECRET: 'webhook-secret',
      OLA_MAPS_API_KEY: 'maps-secret',
      OLA_MAPS_BASE_URL: 'https://maps.example.com',
      METRICS_BEARER_TOKEN: 'a'.repeat(32),
      PICKING_HANDOVER_SECRET: 'h'.repeat(32),
      ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '1': key32 }),
      ADMIN_SESSION_KEY_VERSION: '1',
    });
    expect(production.ADMIN_SESSION_KEY_VERSION).toBe(1);
    expect(production.ADMIN_SESSION_IDLE_SECONDS).toBe(28800);
    expect(production.ADMIN_SESSION_ABSOLUTE_SECONDS).toBe(604800);
    // Without an explicit key ring the production parse fails before startup.
    expect(() =>
      readEnv({
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'cognito',
        COGNITO_CUSTOMER_POOL_ID: 'customer',
        COGNITO_CUSTOMER_CLIENT_ID: 'customer-client',
        COGNITO_WORKFORCE_POOL_ID: 'workforce',
        COGNITO_RIDER_CLIENT_ID: 'rider',
        COGNITO_STORE_CLIENT_ID: 'store',
        COGNITO_ADMIN_CLIENT_ID: 'admin',
      }),
    ).toThrow();
  });
  it('bounds the idle and absolute windows', () => {
    expect(() => readEnv({ ADMIN_SESSION_IDLE_SECONDS: '86401' })).toThrow(
      /ADMIN_SESSION_IDLE_SECONDS/,
    );
    expect(() => readEnv({ ADMIN_SESSION_ABSOLUTE_SECONDS: '2592001' })).toThrow(
      /ADMIN_SESSION_ABSOLUTE_SECONDS/,
    );
    expect(() =>
      readEnv({
        ADMIN_SESSION_IDLE_SECONDS: '86400',
        ADMIN_SESSION_ABSOLUTE_SECONDS: '600',
      }),
    ).toThrow(/ADMIN_SESSION_IDLE_SECONDS/);
  });
  it('requires the active version to exist in a non-empty ring and 32-byte keys', () => {
    expect(() => readEnv({ ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '2': key32 }) })).toThrow(
      /ADMIN_SESSION_KEY_VERSION/,
    );
    expect(() => readEnv({ ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '1': 'tooshort' }) })).toThrow(
      /ADMIN_SESSION_KEYS_JSON/,
    );
    expect(
      readEnv({ ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '1': key32 }) })
        .ADMIN_SESSION_KEY_VERSION,
    ).toBe(1);
  });
});
