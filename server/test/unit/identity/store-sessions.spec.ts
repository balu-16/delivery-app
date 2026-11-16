import { randomBytes } from 'node:crypto';
import { readEnv } from '../../../src/config/env.schema.js';
import { ConfigService } from '../../../src/config/config.service.js';
import {
  AdminSessionStore,
  STORE_SESSION_NAMING,
} from '../../../src/modules/identity/infrastructure/admin-sessions.js';
import type {
  AdminChallengeState,
  AdminSessions,
} from '../../../src/modules/identity/contracts/admin-auth.js';

describe('store portal session store (P-STORE)', () => {
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
        STORE_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
      }),
    );
    return new AdminSessionStore(
      {} as never,
      redis as never,
      config,
      STORE_SESSION_NAMING,
    ) as unknown as AdminSessions;
  }
  const challenge: AdminChallengeState = {
    pool: 'WORKFORCE',
    username: 'manager@example.test',
    providerSession: 'provider-session-string',
  };
  it('namespaces challenges under the store prefix, isolated from admin entries', async () => {
    const redis = fakeRedis();
    const sessions = store(redis);
    const challengeId = randomBytes(16).toString('hex');
    await sessions.putChallenge(challengeId, challenge);
    expect(redis.calls[0]).toEqual(['set', `store:auth:challenge:${challengeId}`, 'EX', '300']);
    expect(await sessions.takeChallenge(challengeId)).toEqual(challenge);
    expect(await sessions.takeChallenge(challengeId)).toBeNull();
    // An admin-portal entry at the same challenge id must be invisible to the store portal.
    await redis.set(`admin:auth:challenge:${challengeId}`, JSON.stringify(challenge), 'EX', 300);
    await expect(sessions.takeChallenge(challengeId)).resolves.toBeNull();
  });
  it('rejects malformed challenge ids like the admin store', async () => {
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
  });
  it('names the store key ring in startup errors, independent from the admin ring', async () => {
    // The schema rejects malformed rings before the store is ever constructed.
    expect(() => readEnv({ STORE_SESSION_KEYS_JSON: 'not-json' })).toThrow(
      /STORE_SESSION_KEYS_JSON/,
    );
    const config = new ConfigService(
      readEnv({
        STORE_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
      }),
    );
    expect(
      () => new AdminSessionStore({} as never, fakeRedis() as never, config, STORE_SESSION_NAMING),
    ).not.toThrow();
  });
  it('defaults the store idle window to 30 minutes and bounds it', () => {
    expect(readEnv({}).STORE_SESSION_IDLE_SECONDS).toBe(1800);
    expect(readEnv({}).STORE_SESSION_ABSOLUTE_SECONDS).toBe(604800);
    expect(() => readEnv({ STORE_SESSION_IDLE_SECONDS: '86401' })).toThrow(
      /STORE_SESSION_IDLE_SECONDS/,
    );
    expect(() =>
      readEnv({
        STORE_SESSION_IDLE_SECONDS: '86400',
        STORE_SESSION_ABSOLUTE_SECONDS: '600',
      }),
    ).toThrow(/STORE_SESSION_IDLE_SECONDS/);
    expect(() =>
      readEnv({
        STORE_SESSION_KEYS_JSON: JSON.stringify({ '2': Buffer.alloc(32, 5).toString('base64') }),
      }),
    ).toThrow(/STORE_SESSION_KEY_VERSION/);
  });
});
