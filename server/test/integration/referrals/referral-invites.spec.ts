import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { REFERRALS, type Referrals } from '../../../src/modules/referrals/contracts/referrals.js';
import {
  IDENTITY_AUTHORIZER,
  type IdentityAuthorizer,
  type VerifiedIdentity,
} from '../../../src/modules/identity/contracts/identity.js';
import { WALLET_VIEWS, type WalletViews } from '../../../src/modules/wallet/contracts/wallet.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(300000);
let world: P5World,
  app: Awaited<ReturnType<typeof createApplication>>,
  referrals: Referrals,
  identity: IdentityAuthorizer,
  views: WalletViews;
const newIdentity = (): VerifiedIdentity => {
  const sub = uuidV7();
  return {
    pool: 'CUSTOMER',
    sub,
    tokenUse: 'id',
    groups: [],
    email: `${sub}@example.invalid`,
    emailVerified: true,
    name: 'Friend',
    expiresAt: 9999999999,
  };
};
async function createInviteFor(userId: string, label?: string) {
  return world.db.db.transaction().execute((tx) => referrals.createInvite(userId, label, tx));
}
async function creditCount(userId: string): Promise<string> {
  const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM wallet_ledger l
    JOIN wallet_accounts a ON a.id = l.account_id
    WHERE a.user_id=${userId}::uuid AND l.ref_type='REFERRAL' AND l.reason='PROMO_GRANT'`.execute(
    world.db.db,
  );
  return rows.rows[0]!.n;
}
beforeAll(async () => {
  world = await createP5World();
  await sql`UPDATE users SET email_verified=true WHERE id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  // Lead migration 068 is not in this base; the test-owned table mirrors its frozen shape.
  await sql`CREATE TABLE IF NOT EXISTS referral_invites (
    id uuid PRIMARY KEY,
    referrer_id uuid NOT NULL REFERENCES users(id),
    code text NOT NULL UNIQUE CHECK (code ~ '^INV-[A-F0-9]{32}$'),
    label text CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 48),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claim_id uuid UNIQUE REFERENCES referral_claims(id)
  )`.execute(world.db.db);
  await sql`CREATE INDEX IF NOT EXISTS referral_invites_referrer_idx ON referral_invites(referrer_id, created_at DESC, id DESC)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES ('wallet_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    world.db.db,
  );
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      ...(world.services.databaseIamUrl
        ? {
            DATABASE_AUTH: 'iam',
            AWS_REGION: process.env.AWS_REGION,
            DB_ACQUIRE_TIMEOUT_MS: '30000',
          }
        : {}),
    }),
    [{ name: 'test', async check() {} }],
  );
  referrals = app.get(REFERRALS);
  identity = app.get(IDENTITY_AUTHORIZER);
  views = app.get(WALLET_VIEWS);
}, 300000);
afterAll(async () => {
  await app?.close();
  if (world) await closeP5World(world);
}, 300000);

test('tracked invite moves pending to successful exactly once on verified signup', async () => {
  const referrer = world.customer;
  const beforePending = (await referrals.view(referrer)).pendingReferrals;
  const beforeSuccessful = (await referrals.view(referrer)).successfulReferrals;
  const invite = await createInviteFor(referrer, '  neighbour  ');
  expect(invite.code).toMatch(/^INV-[A-F0-9]{32}$/);
  expect(invite.reference).toMatch(/^[0-9a-f-]{36}$/i);
  expect(invite.reference).not.toBe(invite.code);
  expect((await referrals.view(referrer)).pendingReferrals).toBe(beforePending + 1);
  const pending = await referrals.history(referrer, 'pending');
  const row = pending.items.find((item) => item.id === invite.reference);
  expect(row).toMatchObject({ label: 'neighbour', status: 'pending', inviteCode: invite.code });
  expect(row?.createdAt).toBeTruthy();

  const friendIdentity = newIdentity();
  const [first, second] = await Promise.all([
    identity.bootstrap(friendIdentity, invite.code),
    identity.bootstrap(friendIdentity, invite.code),
  ]);
  expect(first.userId).toBe(second.userId);
  const view = await referrals.view(referrer);
  expect(view.pendingReferrals).toBe(beforePending);
  expect(view.successfulReferrals).toBe(beforeSuccessful + 1);
  const successful = await referrals.history(referrer, 'successful');
  const done = successful.items.find((item) => item.id === invite.reference);
  expect(done).toMatchObject({ label: 'neighbour', status: 'successful', rewardPaise: '1000' });
  expect(done?.completedAt).toBeTruthy();
  expect(done?.creditExpiresAt).toBeTruthy();
  expect(done?.inviteCode).toBeUndefined();
  const ledger = await sql<{
    n: string;
    amount: string;
  }>`SELECT count(*)::text AS n, COALESCE(sum(l.delta_paise),0)::text AS amount
    FROM referral_claims c JOIN wallet_ledger l ON l.ref_type='REFERRAL' AND l.ref_id='referral:'||c.id::text
    WHERE c.friend_id=${first.userId}::uuid`.execute(world.db.db);
  expect(ledger.rows[0]).toEqual({ n: '1', amount: '1000' });
  expect((await referrals.view(first.userId)).freeDeliveryAvailable).toBe(true);
  expect((await views.balances(first.userId)).promoPaise).toBe('0');
  // A second new account with the used invite is a conflict, not a silent replay.
  await expect(identity.bootstrap(newIdentity(), invite.code)).rejects.toThrow(
    'REFERRAL_INVITE_USED',
  );
}, 300000);

test('history is owner-scoped and rejects invalid filters, cursors and limits', async () => {
  const other = world.otherCustomer;
  await sql`UPDATE users SET email_verified=true WHERE id=${other}::uuid`.execute(world.db.db);
  const invite = await createInviteFor(world.customer, undefined);
  expect(
    (await referrals.history(other, 'pending')).items.find((item) => item.id === invite.reference),
  ).toBeUndefined();
  expect((await referrals.history(other, 'successful')).items).toEqual([]);
  await expect(
    // @ts-expect-error invalid status cast for the negative case
    referrals.history(world.customer, 'everything'),
  ).rejects.toThrow('INVALID_PAGE');
  await expect(referrals.history(world.customer, 'pending', 'not-a-cursor')).rejects.toThrow(
    'INVALID_PAGE',
  );
  await expect(referrals.history(world.customer, 'pending', undefined, 0)).rejects.toThrow(
    'INVALID_PAGE',
  );
  await expect(referrals.history(world.customer, 'pending', undefined, 51)).rejects.toThrow(
    'INVALID_PAGE',
  );
  const page = await referrals.history(world.customer, 'pending', undefined, 1);
  if (page.nextCursor) {
    // A successful cursor must not validate under the other filter or account.
    await expect(referrals.history(world.customer, 'successful', page.nextCursor)).rejects.toThrow(
      'INVALID_PAGE',
    );
    await expect(referrals.history(other, 'pending', page.nextCursor)).rejects.toThrow(
      'INVALID_PAGE',
    );
  }
}, 300000);

test('existing accounts cannot claim a pending invite but can replay their own', async () => {
  const referrer = world.customer;
  const invite = await createInviteFor(referrer, 'replay check');
  const existingIdentity = newIdentity();
  await identity.bootstrap(existingIdentity);
  await expect(identity.bootstrap(existingIdentity, invite.code)).rejects.toThrow(
    'REFERRAL_SIGNUP_ONLY',
  );
  const friend = newIdentity();
  const principal = await identity.bootstrap(friend, invite.code);
  // Matching retry after the lost response succeeds without a second credit.
  const before = await creditCount(referrer);
  const replayed = await identity.bootstrap(friend, invite.code);
  expect(replayed.userId).toBe(principal.userId);
  expect(await creditCount(referrer)).toBe(before);
}, 300000);

test('disabled programme keeps history readable and blocks creation and redemption', async () => {
  const referrer = world.customer;
  const invite = await createInviteFor(referrer, 'disabled check');
  await sql`UPDATE feature_flags SET enabled=false WHERE key='wallet_enabled'`.execute(world.db.db);
  try {
    await expect(createInviteFor(referrer, 'nope')).rejects.toThrow('REFERRALS_UNAVAILABLE');
    await expect(identity.bootstrap(newIdentity(), invite.code)).rejects.toThrow(
      'REFERRALS_UNAVAILABLE',
    );
    expect(
      (await referrals.history(referrer, 'pending')).items.some(
        (item) => item.id === invite.reference,
      ),
    ).toBe(true);
    const view = await referrals.view(referrer);
    expect(view.enabled).toBe(false);
    expect(view.code).toBeNull();
    expect(view.pendingReferrals).toBeGreaterThanOrEqual(1);
  } finally {
    await sql`UPDATE feature_flags SET enabled=true WHERE key='wallet_enabled'`.execute(
      world.db.db,
    );
  }
  // The invite blocked while disabled still redeems after re-enable.
  const friend = await identity.bootstrap(newIdentity(), invite.code);
  expect(friend.userId).toBeTruthy();
}, 300000);

test('a rolled-back bootstrap leaves the invite pending with zero wallet movement', async () => {
  const referrer = world.customer;
  const invite = await createInviteFor(referrer, 'rollback check');
  const creditsBefore = await creditCount(referrer);
  const friendId = uuidV7();
  await expect(
    world.db.db.transaction().execute(async (tx) => {
      // Stand in for the bootstrap user insert inside the same transaction.
      // NOTE: placeholders cannot sit inside SQL string literals — build the values in JS.
      const sub = `rollback-${friendId}`;
      await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES(${friendId}::uuid,'CUSTOMER',${sub},${`${sub}@example.invalid`},'Rollback',true)`.execute(
        tx,
      );
      await referrals.claimForNewCustomer(invite.code, friendId, tx);
      throw new Error('BOOTSTRAP_ROLLED_BACK');
    }),
  ).rejects.toThrow('BOOTSTRAP_ROLLED_BACK');
  const pending = await referrals.history(referrer, 'pending');
  expect(pending.items.some((item) => item.id === invite.reference)).toBe(true);
  expect(await creditCount(referrer)).toBe(creditsBefore);
}, 300000);

test('concurrent bootstraps with one invite produce one claim and one credit', async () => {
  const referrer = world.customer;
  const invite = await createInviteFor(referrer, 'race check');
  const results = await Promise.allSettled([
    identity.bootstrap(newIdentity(), invite.code),
    identity.bootstrap(newIdentity(), invite.code),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const reason = rejected[0] as PromiseRejectedResult;
  expect(String((reason.reason as Error).message)).toContain('REFERRAL_INVITE_USED');
  const claims = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM referral_invites WHERE id=${invite.reference}::uuid AND claim_id IS NOT NULL`.execute(
    world.db.db,
  );
  expect(claims.rows[0]!.n).toBe('1');
}, 300000);

test('label limits and invite creation rate limit are enforced', async () => {
  const referrer = world.customer;
  await expect(createInviteFor(referrer, 'a'.repeat(49))).rejects.toThrow('INVALID_INPUT');
  const capped = await identity.bootstrap(newIdentity());
  await sql`UPDATE users SET email_verified=true WHERE id=${capped.userId}::uuid`.execute(
    world.db.db,
  );
  for (let i = 0; i < 20; i++) await createInviteFor(capped.userId, `n${i}`);
  await expect(createInviteFor(capped.userId, 'over')).rejects.toThrow('RATE_LIMITED');
}, 300000);
