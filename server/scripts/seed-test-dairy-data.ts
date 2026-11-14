/** Data for the explicitly scoped AWS development catalog, never production fixtures. */
export const TEST_ACCOUNT = '102364304362';
export const TEST_REGION = 'ap-southeast-2';
export const TEST_CLUSTER = 'database-1';
export const TEST_DATABASE = 'deliveryapp';
export const TEST_CATEGORY = 'Test Dairy';
export const TEST_DESCRIPTION = 'Test product for app checkout. Image is illustrative.';

export const TEST_STORES = [
  { id: '01800000-0000-7000-8000-000000000011', name: 'Central' },
  { id: '01800000-0000-7000-8000-000000000012', name: 'South' },
  { id: '01800000-0000-7000-8000-000000000013', name: 'North' },
] as const;

export const TEST_PRODUCTS = [
  {
    sku: 'DD-TEST-001',
    name: 'Test full-cream milk',
    pack: '500 ml',
    paise: '3500',
    hsn: '0401',
    image: 'milk-hd.png',
  },
  {
    sku: 'DD-TEST-002',
    name: 'Test toned milk',
    pack: '500 ml',
    paise: '3000',
    hsn: '0401',
    image: 'milk-hd.png',
  },
  {
    sku: 'DD-TEST-003',
    name: 'Test A2 milk',
    pack: '500 ml',
    paise: '5500',
    hsn: '0401',
    image: 'milk-hd.png',
  },
  {
    sku: 'DD-TEST-004',
    name: 'Test curd',
    pack: '400 g',
    paise: '4500',
    hsn: '0403',
    image: 'curd-hd.png',
  },
  {
    sku: 'DD-TEST-005',
    name: 'Test paneer',
    pack: '200 g',
    paise: '10000',
    hsn: '0406',
    image: 'paneer-hd.png',
  },
  {
    sku: 'DD-TEST-006',
    name: 'Test butter',
    pack: '100 g',
    paise: '6000',
    hsn: '0405',
    image: 'butter-hd.png',
  },
  {
    sku: 'DD-TEST-007',
    name: 'Test ghee',
    pack: '200 ml',
    paise: '16000',
    hsn: '0405',
    image: 'ghee-hd.png',
  },
  {
    sku: 'DD-TEST-008',
    name: 'Test buttermilk',
    pack: '200 ml',
    paise: '2000',
    hsn: '0403',
    image: 'buttermilk-hd.png',
  },
  {
    sku: 'DD-TEST-009',
    name: 'Test sweet lassi',
    pack: '200 ml',
    paise: '3500',
    hsn: '0403',
    image: 'lassi-hd.png',
  },
  {
    sku: 'DD-TEST-010',
    name: 'Test yogurt',
    pack: '200 g',
    paise: '4000',
    hsn: '0403',
    image: 'curd-hd.png',
  },
] as const;

/** Stop starting work after an error, but let already-started operations settle safely. */
export async function mapLimited<T, R>(
  values: readonly T[],
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const results: R[] = new Array(values.length);
  async function worker(): Promise<void> {
    while (!failed) {
      const index = next++;
      if (index >= values.length) return;
      try {
        results[index] = await work(values[index]!);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(values.length, 3) }, () => worker()));
  if (failed) throw failure;
  return results;
}

export function assertTestTarget(input: {
  account: string;
  region: string;
  nodeEnv: string;
  auth: string;
  databaseAuth: string;
  storage: string;
  databaseUrl: string;
  clusterEndpoint: string;
}): void {
  let database: URL;
  try {
    database = new URL(input.databaseUrl);
  } catch {
    throw new Error('UNSAFE_TEST_TARGET');
  }
  if (
    input.account !== TEST_ACCOUNT ||
    input.region !== TEST_REGION ||
    input.nodeEnv !== 'development' ||
    input.auth !== 'cognito' ||
    input.databaseAuth !== 'iam' ||
    input.storage !== 's3' ||
    database.hostname !== input.clusterEndpoint ||
    database.pathname !== `/${TEST_DATABASE}` ||
    !input.clusterEndpoint ||
    input.clusterEndpoint === 'None'
  )
    throw new Error('UNSAFE_TEST_TARGET');
}
