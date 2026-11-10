import { runtimeQueuePrefix } from '../../../src/platform/platform.module.js';

test('isolates generated local and AWS integration databases from shared queues', () => {
  const id = '0123456789abcdef0123456789abcdef';
  expect(
    runtimeQueuePrefix({ NODE_ENV: 'test', DATABASE_URL: `postgres://a@host/delivery_p13_${id}` }),
  ).toBe(`test:${id}`);
  expect(
    runtimeQueuePrefix({ NODE_ENV: 'test', DATABASE_URL: `postgres://a@host/delivery_test_${id}` }),
  ).toBe(`test:${id}`);
  expect(
    runtimeQueuePrefix({ NODE_ENV: 'test', DATABASE_URL: 'postgres://a@host/deliveryapp' }),
  ).toBe('delivery');
  expect(
    runtimeQueuePrefix({
      NODE_ENV: 'production',
      DATABASE_URL: `postgres://a@host/delivery_p13_${id}`,
    }),
  ).toBe('delivery');
});
