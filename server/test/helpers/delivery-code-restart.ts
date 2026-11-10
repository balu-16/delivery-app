import { createDatabase } from '../../src/platform/database/database.js';
import type { ConfigService } from '../../src/config/config.service.js';
import type { AppConfig } from '../../src/modules/app-config/contracts/config.js';
import { OrderCodeService } from '../../src/modules/orders/infrastructure/delivery-codes.js';

const { TEST_CODE_DATABASE_URL, TEST_CODE_DATABASE_REGION, TEST_CODE_ORDER, TEST_CODE_USER } =
  process.env;
if (!TEST_CODE_DATABASE_URL || !TEST_CODE_ORDER || !TEST_CODE_USER)
  throw new Error('Test database, order and user are required');
const db = createDatabase(
  TEST_CODE_DATABASE_URL,
  1,
  30000,
  undefined,
  30000,
  TEST_CODE_DATABASE_REGION,
);
const runtime = {
  get: (key: string) => {
    if (key === 'PICKING_CODE_KEY_VERSION') return 2;
    if (key === 'PICKING_CODE_KEYS_JSON')
      return JSON.stringify({ '1': 'test-key-one-long-enough', '2': 'test-key-two-long-enough' });
    throw new Error('unexpected config key');
  },
} as unknown as ConfigService;
const config = { get: async () => 3 } as unknown as AppConfig;
try {
  const service = new OrderCodeService(db.db, runtime, config);
  process.stdout.write(JSON.stringify(await service.present(TEST_CODE_ORDER, TEST_CODE_USER)));
} finally {
  await db.close();
}
