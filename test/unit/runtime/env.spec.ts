import { readEnv } from '../../../src/config/env.schema.js';

describe('runtime environment', () => {
  it('uses local defaults and includes every source key', () => {
    const env = readEnv({});
    expect(env.APP_ROLE).toBe('all');
    expect(env.DATABASE_URL).toMatch(/^postgres:/);
    expect(env.MAPS_MATRIX_TOP_K).toBe(5);
    expect(env.COGNITO_WORKFORCE_POOL_ID).toBe('');
  });
  it('reports missing provider settings without exposing values', () => {
    expect(() =>
      readEnv({ PAYMENTS_PROVIDER: 'razorpay', RAZORPAY_KEY_SECRET: 'super-secret' }),
    ).toThrow(/RAZORPAY_KEY_ID/);
    try {
      readEnv({ PAYMENTS_PROVIDER: 'razorpay', RAZORPAY_KEY_SECRET: 'super-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
  });
  it('rejects fake providers and unsafe local defaults in production', () => {
    expect(() => readEnv({ NODE_ENV: 'production' })).toThrow(/AUTH_PROVIDER/);
    expect(() => readEnv({ CORS_ALLOWED_ORIGINS: '*' })).toThrow(/CORS_ALLOWED_ORIGINS/);
    expect(() => readEnv({ HTTP_BODY_LIMIT_BYTES: '0' })).toThrow(/HTTP_BODY_LIMIT_BYTES/);
    expect(() => readEnv({ REDIS_URL: 'http://example.com' })).toThrow(/REDIS_URL/);
    expect(() => readEnv({ DATABASE_URL: 'http://example.com' })).toThrow(/DATABASE_URL/);
    expect(() => readEnv({ LOCAL_PRIVATE_STORAGE_DIR: 'relative/path' })).toThrow(
      /LOCAL_PRIVATE_STORAGE_DIR/,
    );
    expect(() => readEnv({ PRIVATE_UPLOAD_MAX_BYTES: '0' })).toThrow(/PRIVATE_UPLOAD_MAX_BYTES/);
    expect(() => readEnv({ LOCAL_CATALOG_STORAGE_DIR: 'relative/path' })).toThrow(
      /LOCAL_CATALOG_STORAGE_DIR/,
    );
    expect(() => readEnv({ CATALOG_UPLOAD_MAX_BYTES: '0' })).toThrow(/CATALOG_UPLOAD_MAX_BYTES/);
  });
});

describe('production environment', () => {
  const production = {
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
  };
  it('accepts a complete non-local provider configuration', () => {
    expect(readEnv(production).NODE_ENV).toBe('production');
  });
  it('rejects test gateway keys and local service endpoints', () => {
    expect(() => readEnv({ ...production, RAZORPAY_KEY_ID: 'rzp_test_example' })).toThrow(
      /RAZORPAY_KEY_ID/,
    );
    expect(() => readEnv({ ...production, S3_ENDPOINT: 'http://localhost:4566' })).toThrow(
      /S3_ENDPOINT/,
    );
    expect(() => readEnv({ ...production, CORS_ALLOWED_ORIGINS: 'http://localhost:5173' })).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
    expect(() => readEnv({ ...production, EMAIL_PROVIDER: 'smtp' })).toThrow(/EMAIL_PROVIDER/);
    expect(() => readEnv({ ...production, APP_BASE_URL: 'http://api.example.com' })).toThrow(
      /APP_BASE_URL/,
    );
    expect(() => readEnv({ ...production, CDN_BASE_URL: 'https://secret@example.com' })).toThrow(
      /CDN_BASE_URL/,
    );
    expect(() => readEnv({ ...production, S3_PRIVATE_BUCKET: 'media-bucket' })).toThrow(
      /S3_PRIVATE_BUCKET/,
    );
    expect(() =>
      readEnv({ ...production, PICKING_HANDOVER_SECRET: 'picking-handover-local-dev-secret-v1' }),
    ).toThrow(/PICKING_HANDOVER_SECRET/);
  });
});
