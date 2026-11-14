import { readEnv } from '../../../src/config/env.schema.js';

const valid = {
  AWS_REGION: 'ap-southeast-2',
  DATABASE_AUTH: 'iam',
  DATABASE_URL: 'postgres://app@db.example:5432/deliveryapp',
  CACHE_AUTH: 'elasticache-iam',
  CACHE_URL: 'rediss://cache.example:6379',
  CACHE_IAM_NAME: 'cache',
  CACHE_IAM_USER: 'cache-user',
};

test('IAM configuration requires TLS cache and password-free endpoints', () => {
  expect(readEnv(valid).DATABASE_AUTH).toBe('iam');
  expect(() => readEnv({ ...valid, CACHE_URL: 'redis://cache.example:6379' })).toThrow();
  expect(() =>
    readEnv({ ...valid, CACHE_URL: 'rediss://user:secret@cache.example:6379' }),
  ).toThrow();
  expect(() =>
    readEnv({ ...valid, DATABASE_URL: 'postgres://app:secret@db.example/deliveryapp' }),
  ).toThrow();
  expect(() =>
    readEnv({ ...valid, DATABASE_URL: 'postgres://app@db.example/deliveryapp?sslmode=disable' }),
  ).toThrow();
});

test('SQS requires the explicit development account and a valid region', () => {
  expect(
    readEnv({ ...valid, QUEUE_TRANSPORT: 'sqs', AWS_ACCOUNT_ID: '123456789012' }).QUEUE_TRANSPORT,
  ).toBe('sqs');
  expect(() => readEnv({ ...valid, QUEUE_TRANSPORT: 'sqs' })).toThrow('AWS_ACCOUNT_ID');
  expect(() =>
    readEnv({ ...valid, QUEUE_TRANSPORT: 'sqs', AWS_ACCOUNT_ID: '123', AWS_REGION: 'invalid' }),
  ).toThrow('AWS_ACCOUNT_ID');
});

test('customer group retry queue must be an AWS SQS URL in the configured account and region', () => {
  const cognito = {
    ...valid,
    AUTH_PROVIDER: 'cognito',
    AWS_ACCOUNT_ID: '123456789012',
    COGNITO_CUSTOMER_POOL_ID: 'pool',
    COGNITO_CUSTOMER_CLIENT_ID: 'customer',
    COGNITO_WORKFORCE_POOL_ID: 'pool',
    COGNITO_RIDER_CLIENT_ID: 'rider',
    COGNITO_STORE_CLIENT_ID: 'store',
    COGNITO_ADMIN_CLIENT_ID: 'admin',
  };
  const url = 'https://sqs.ap-southeast-2.amazonaws.com/123456789012/customer-group';
  expect(
    readEnv({ ...cognito, CUSTOMER_GROUP_SYNC_QUEUE_URL: url }).CUSTOMER_GROUP_SYNC_QUEUE_URL,
  ).toBe(url);
  for (const invalid of [
    'https://sqs.ap-southeast-2.amazonaws.com.evil.test/123456789012/customer-group',
    'https://sqs.ap-southeast-2.amazonaws.com/999999999999/customer-group',
    'http://sqs.ap-southeast-2.amazonaws.com/123456789012/customer-group',
    `${url}?secret=1`,
  ])
    expect(() => readEnv({ ...cognito, CUSTOMER_GROUP_SYNC_QUEUE_URL: invalid })).toThrow(
      'CUSTOMER_GROUP_SYNC_QUEUE_URL',
    );
});

test('SQS requires safe queue prefixes and rejects development names in production', () => {
  const sqs = { ...valid, QUEUE_TRANSPORT: 'sqs', AWS_ACCOUNT_ID: '123456789012' };
  expect(readEnv(sqs).SQS_QUEUE_PREFIX).toBe('');
  expect(readEnv({ ...sqs, SQS_QUEUE_PREFIX: 'delivery-prod' }).SQS_QUEUE_PREFIX).toBe(
    'delivery-prod',
  );
  expect(() => readEnv({ ...sqs, SQS_QUEUE_PREFIX: 'delivery-*' })).toThrow('SQS_QUEUE_PREFIX');
  expect(() => readEnv({ ...sqs, SQS_QUEUE_PREFIX: 'x'.repeat(65) })).toThrow('SQS_QUEUE_PREFIX');
  expect(() => readEnv({ ...sqs, NODE_ENV: 'production' })).toThrow('SQS_QUEUE_PREFIX');
  expect(() =>
    readEnv({ ...sqs, NODE_ENV: 'production', SQS_QUEUE_PREFIX: 'delivery-dev' }),
  ).toThrow('SQS_QUEUE_PREFIX');
});
