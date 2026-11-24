import { expect, test } from '@jest/globals';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { fakeDatabase } from '../helpers/fake-db.js';

/** Routes compiled SQL to canned rows by distinctive fragment. */
function service(route: (sql: string) => { rows: unknown[]; numAffectedRows?: bigint | number }) {
  const { db, queries } = fakeDatabase((query) => route(query.sql as string));
  return { svc: new ConfigService(db), queries };
}

const ADMIN = [{ id: '01800000-0000-7000-8000-0000000000aa' }];

function adminRoutes(overrides: {
  appConfigRows?: Array<{ key: string; value: unknown; version: string }>;
  versionRows?: Array<{ key: string; version: string }>;
  flagRows?: Array<{ key: string; enabled: boolean; version: string }>;
  insertVersion?: string;
  authorized?: unknown[];
}): (sql: string) => { rows: unknown[]; numAffectedRows?: number } {
  return (sql: string) => {
    if (sql.includes('pg_advisory')) return { rows: [] };
    if (sql.includes('FROM users u JOIN user_roles'))
      return { rows: overrides.authorized ?? ADMIN };
    if (sql.includes('INSERT INTO app_config'))
      return { rows: [{ version: overrides.insertVersion ?? '4' }] };
    if (sql.includes('SELECT key,version::text AS version FROM app_config'))
      return { rows: overrides.versionRows ?? [] };
    if (sql.includes('SELECT key,value,version::text')) {
      // getMany select (snapshot values + update reads): value+version rows.
      return {
        rows: (overrides.appConfigRows ?? []).map((row) => ({
          key: row.key,
          value: row.value,
          version: row.version,
        })),
      };
    }
    if (sql.includes('SELECT key,enabled,version::text AS version FROM feature_flags'))
      return { rows: overrides.flagRows ?? [] };
    if (sql.includes('FROM feature_flags'))
      return {
        rows: (overrides.flagRows ?? []).map((row) => ({
          enabled: row.enabled,
          version: row.version,
        })),
      };
    return { rows: [] };
  };
}

test('referral keys default to enabled, 1000 paise, 1 month with no rows', async () => {
  const { svc } = service(adminRoutes({}));
  const values = await svc.getMany([
    'referralIssuanceEnabled',
    'referralRewardPaise',
    'referralCreditExpiryMonths',
  ]);
  expect(values).toEqual({
    referralIssuanceEnabled: true,
    referralRewardPaise: '1000',
    referralCreditExpiryMonths: 1,
  });
});

test('batch update returns new values and decimal-string versions', async () => {
  const { svc, queries } = service(
    adminRoutes({
      appConfigRows: [{ key: 'minOrderPaise', value: '1000', version: '3' }],
    }),
  );
  const updated = await svc.updateBatch(ADMIN[0]!.id, [
    { key: 'minOrderPaise', value: '2000', expectedVersion: '3' },
    { key: 'maxOrderPaise', value: '50000000', expectedVersion: '0' },
  ]);
  expect(updated).toEqual([
    { key: 'minOrderPaise', value: '2000', version: '4' },
    { key: 'maxOrderPaise', value: '50000000', version: '4' },
  ]);
  const inserts = queries.filter((q) => (q.sql as string).includes('INSERT INTO app_config'));
  expect(inserts).toHaveLength(2);
  expect(
    queries.filter((q) => (q.sql as string).includes('INSERT INTO config_history')),
  ).toHaveLength(2);
  expect(queries.filter((q) => (q.sql as string).includes('INSERT INTO audit_log'))).toHaveLength(
    2,
  );
});

test('stale expectedVersion aborts the batch with no partial write', async () => {
  const { svc, queries } = service(
    adminRoutes({
      appConfigRows: [{ key: 'minOrderPaise', value: '1000', version: '3' }],
    }),
  );
  await expect(
    svc.updateBatch(ADMIN[0]!.id, [
      { key: 'minOrderPaise', value: '2000', expectedVersion: '3' },
      { key: 'maxOrderPaise', value: '50000000', expectedVersion: '1' },
    ]),
  ).rejects.toThrow('CONCURRENT_MODIFICATION');
  expect(queries.filter((q) => (q.sql as string).includes('INSERT INTO app_config'))).toHaveLength(
    0,
  );
});

test('duplicate keys are rejected before any write', async () => {
  const { svc, queries } = service(adminRoutes({}));
  await expect(
    svc.updateBatch(ADMIN[0]!.id, [
      { key: 'minOrderPaise', value: '2000' },
      { key: 'minOrderPaise', value: '3000' },
    ]),
  ).rejects.toThrow('DUPLICATE_CONFIG_KEY');
  expect(queries.filter((q) => (q.sql as string).includes('INSERT INTO app_config'))).toHaveLength(
    0,
  );
});

test('a combined-schema-invalid batch (min above max) writes nothing', async () => {
  const { svc, queries } = service(adminRoutes({}));
  await expect(
    svc.updateBatch(ADMIN[0]!.id, [
      { key: 'minOrderPaise', value: '999999999', expectedVersion: '0' },
    ]),
  ).rejects.toThrow();
  expect(queries.filter((q) => (q.sql as string).includes('INSERT INTO app_config'))).toHaveLength(
    0,
  );
});

test('single-key update with a stale expectedVersion conflicts', async () => {
  const { svc, queries } = service(
    adminRoutes({
      appConfigRows: [{ key: 'minOrderPaise', value: '1000', version: '3' }],
    }),
  );
  await expect(svc.update(ADMIN[0]!.id, 'minOrderPaise', '2000', '1')).rejects.toThrow(
    'CONCURRENT_MODIFICATION',
  );
  expect(queries.filter((q) => (q.sql as string).includes('INSERT INTO app_config'))).toHaveLength(
    0,
  );
});

test('flag write guard checks the flag revision', async () => {
  const { svc, queries } = service(
    adminRoutes({
      flagRows: [{ key: 'wallet_enabled', enabled: true, version: '2' }],
    }),
  );
  await expect(svc.setFlag(ADMIN[0]!.id, 'wallet_enabled', false, '1')).rejects.toThrow(
    'CONCURRENT_MODIFICATION',
  );
  expect(
    queries.filter((q) => (q.sql as string).includes('INSERT INTO feature_flags')),
  ).toHaveLength(0);
});

test('snapshot returns decimal-string revisions with 0 for defaults', async () => {
  const { svc } = service(
    adminRoutes({
      versionRows: [{ key: 'minOrderPaise', version: '5' }],
      flagRows: [{ key: 'wallet_enabled', enabled: true, version: '2' }],
    }),
  );
  const snapshot = await svc.snapshot();
  expect(snapshot.configRevisions.minOrderPaise).toBe('5');
  expect(snapshot.configRevisions.referralRewardPaise).toBe('0');
  expect(snapshot.flagRevisions.wallet_enabled).toBe('2');
  expect(snapshot.flagRevisions.cod_enabled).toBe('0');
  expect(snapshot.config.referralRewardPaise).toBe('1000');
  expect(snapshot.config.referralCreditExpiryMonths).toBe(1);
  expect(snapshot.flags.wallet_enabled).toBe(true);
});

test('referral reward and expiry validation: positive paise, 1-12 months', async () => {
  const { svc } = service(adminRoutes({}));
  await expect(svc.update(ADMIN[0]!.id, 'referralRewardPaise', '0')).rejects.toThrow();
  await expect(
    svc.update(ADMIN[0]!.id, 'referralRewardPaise', '9223372036854775808'),
  ).rejects.toThrow();
  await expect(svc.update(ADMIN[0]!.id, 'referralCreditExpiryMonths', 0)).rejects.toThrow();
  await expect(svc.update(ADMIN[0]!.id, 'referralCreditExpiryMonths', 13)).rejects.toThrow();
  await expect(svc.update(ADMIN[0]!.id, 'referralCreditExpiryMonths', 2.5)).rejects.toThrow();
});

test('batch without version guards keeps the single-key path working', async () => {
  const { svc } = service(adminRoutes({}));
  const updated = await svc.updateBatch(ADMIN[0]!.id, [
    { key: 'referralCreditExpiryMonths', value: 3 },
  ]);
  expect(updated).toEqual([{ key: 'referralCreditExpiryMonths', value: 3, version: '4' }]);
});

test('non-super-admin batch write is forbidden', async () => {
  const { svc } = service(adminRoutes({ authorized: [] }));
  await expect(
    svc.updateBatch(ADMIN[0]!.id, [{ key: 'minOrderPaise', value: '100' }]),
  ).rejects.toThrow('FORBIDDEN');
});

test('empty batch is invalid', async () => {
  const { svc } = service(adminRoutes({}));
  await expect(svc.updateBatch(ADMIN[0]!.id, [])).rejects.toThrow('INVALID_CONFIG_KEY');
});
