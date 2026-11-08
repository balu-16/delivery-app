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
