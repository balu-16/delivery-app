import {
  assertTestTarget,
  mapLimited,
  TEST_ACCOUNT,
  TEST_PRODUCTS,
  TEST_REGION,
  TEST_STORES,
} from '../../../scripts/seed-test-dairy-data.js';

const target = {
  account: TEST_ACCOUNT,
  region: TEST_REGION,
  nodeEnv: 'development',
  auth: 'cognito',
  databaseAuth: 'iam',
  storage: 's3',
  databaseUrl: 'postgres://fixture@cluster.example/deliveryapp',
  clusterEndpoint: 'cluster.example',
};

test('test setup only accepts the expected development account and database', () => {
  expect(() => assertTestTarget(target)).not.toThrow();
  for (const change of [
    { account: '999999999999' },
    { region: 'ap-south-1' },
    { nodeEnv: 'production' },
    { auth: 'local' },
    { databaseAuth: 'password' },
    { storage: 'local' },
    { databaseUrl: 'postgres://fixture@cluster.example/production' },
    { clusterEndpoint: 'other.example' },
  ])
    expect(() => assertTestTarget({ ...target, ...change })).toThrow('UNSAFE_TEST_TARGET');
});

test('fixture products and stores have unique identities and positive integer prices', () => {
  expect(TEST_PRODUCTS).toHaveLength(10);
  expect(new Set(TEST_PRODUCTS.map((item) => item.sku)).size).toBe(10);
  expect(new Set(TEST_PRODUCTS.map((item) => item.name)).size).toBe(10);
  expect(new Set(TEST_STORES.map((store) => store.id)).size).toBe(3);
  for (const item of TEST_PRODUCTS) {
    expect(item.name).toMatch(/^Test /);
    expect(item.paise).toMatch(/^[1-9]\d*$/);
    expect(item.image).toMatch(/^[a-z-]+-hd\.png$/);
  }
});

test('bounded setup work keeps input order and stops starting items after failure', async () => {
  let active = 0;
  let peak = 0;
  const values = await mapLimited([1, 2, 3, 4, 5], async (value) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return value * 2;
  });
  expect(values).toEqual([2, 4, 6, 8, 10]);
  expect(peak).toBe(3);
  const started: number[] = [];
  await expect(
    mapLimited([1, 2, 3, 4, 5], async (value) => {
      started.push(value);
      if (value === 1) throw new Error('STOP');
      await Promise.resolve();
      return value;
    }),
  ).rejects.toThrow('STOP');
  expect(started).toEqual([1, 2, 3]);
});
