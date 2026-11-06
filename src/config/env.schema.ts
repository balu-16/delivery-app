import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const optional = z.string().default('');
const url = (fallback: string) => z.string().url().default(fallback);

/** The complete source Section 8 contract plus explicitly named runtime extras. */
const envBaseSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ROLE: z.enum(['all', 'customer', 'rider', 'store', 'admin', 'worker']).default('all'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_BASE_URL: url('http://localhost:3000'),
    CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
    SHUTDOWN_TIMEOUT_MS: positiveInteger(15000),
    BUSINESS_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    AUTH_PROVIDER: z.enum(['local', 'cognito']).default('local'),
    PAYMENTS_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
    MAPS_PROVIDER: z.enum(['fake', 'ola']).default('fake'),
    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    EMAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),
    PUSH_PROVIDER: z.enum(['fake', 'fcm']).default('fake'),
    DATABASE_URL: url('postgres://app:app@localhost:5432/delivery'),
    DATABASE_POOL_MAX: positiveInteger(20),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(10000),
    REDIS_URL: url('redis://localhost:6379'),
    LOCAL_JWT_SECRET: z.string().default('local-dev-only-change-me'),
    AWS_REGION: z.string().default('ap-south-1'),
    COGNITO_CUSTOMER_POOL_ID: optional,
    COGNITO_CUSTOMER_CLIENT_ID: optional,
    COGNITO_WORKFORCE_POOL_ID: optional,
    COGNITO_RIDER_CLIENT_ID: optional,
    COGNITO_STORE_CLIENT_ID: optional,
    COGNITO_ADMIN_CLIENT_ID: optional,
    COGNITO_TIMEOUT_MS: positiveInteger(3000),
    COGNITO_BREAKER_FAILURES: positiveInteger(5),
    COGNITO_BREAKER_COOLDOWN_MS: positiveInteger(30000),
    S3_MEDIA_BUCKET: optional,
    S3_PRIVATE_BUCKET: optional,
    S3_ENDPOINT: optional,
    CDN_BASE_URL: optional,
    SES_FROM_ADDRESS: optional,
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    FCM_SERVICE_ACCOUNT_JSON_SECRET: optional,
    RAZORPAY_KEY_ID: optional,
    RAZORPAY_KEY_SECRET: optional,
    RAZORPAY_WEBHOOK_SECRET: optional,
    OLA_MAPS_API_KEY: optional,
    OLA_MAPS_BASE_URL: z.string().default('https://api.olamaps.io'),
    // Extra maps paths and timeout: configurable because provider contracts may change.
    OLA_MAPS_AUTOCOMPLETE_PATH: z.string().default('/places/v1/autocomplete'),
    OLA_MAPS_DETAILS_PATH: z.string().default('/places/v1/details'),
    OLA_MAPS_GEOCODE_PATH: z.string().default('/places/v1/geocode'),
    OLA_MAPS_REVERSE_PATH: z.string().default('/places/v1/reverse-geocode'),
    OLA_MAPS_DIRECTIONS_PATH: z.string().default('/routing/v1/directions'),
    OLA_MAPS_MATRIX_PATH: z.string().default('/routing/v1/distanceMatrix/basic'),
    OLA_MAPS_TIMEOUT_MS: positiveInteger(3000),
    OLA_MAPS_BREAKER_FAILURES: positiveInteger(5),
    OLA_MAPS_BREAKER_COOLDOWN_MS: positiveInteger(30000),
    OLA_MAPS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(2),
    MAPS_CACHE_TTL_SECONDS: positiveInteger(2592000),
    MAPS_MATRIX_TOP_K: positiveInteger(5),
    RATE_LIMIT_DEFAULT_PER_MIN: positiveInteger(120),
    RATE_LIMIT_AUTH_PER_MIN: positiveInteger(20),
    RATE_LIMIT_SEARCH_PER_MIN: positiveInteger(30),
    RATE_LIMIT_LOCATION_PER_MIN: positiveInteger(30),
    // Extras: HTTP body hard cap, bearer secret for operational metrics.
    HTTP_BODY_LIMIT_BYTES: positiveInteger(1048576),
    PRIVATE_UPLOAD_MAX_BYTES: positiveInteger(5242880),
    CATALOG_UPLOAD_MAX_BYTES: positiveInteger(20971520),
    PRIVATE_UPLOAD_URL_TTL_SECONDS: positiveInteger(300),
    PRIVATE_READ_URL_TTL_SECONDS: positiveInteger(60),
    LOCAL_PRIVATE_STORAGE_DIR: z.string().default(resolve(process.cwd(), '.local/private')),
    LOCAL_CATALOG_STORAGE_DIR: z.string().default(resolve(process.cwd(), '.local/catalog')),
    METRICS_BEARER_TOKEN: optional,
  })
  .strict();

export const envSchema = envBaseSchema.superRefine((env, ctx) => {
  const fail = (key: keyof typeof env, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
  const set = (value: string) =>
    value.trim().length > 0 && !/^(placeholder|changeme|change-me)$/i.test(value.trim());
  const need = (keys: (keyof typeof env)[]) =>
    keys.forEach((key) => {
      if (!set(String(env[key]))) fail(key, 'Required for the selected provider');
    });
  for (const [key, protocols] of [
    ['DATABASE_URL', ['postgres:', 'postgresql:']],
    ['REDIS_URL', ['redis:', 'rediss:']],
    ['APP_BASE_URL', ['http:', 'https:']],
  ] as const) {
    try {
      if (!(protocols as readonly string[]).includes(new URL(env[key]).protocol))
        fail(key, 'Invalid URL scheme');
    } catch {
      fail(key, 'Invalid URL');
    }
  }
  const origins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!isAbsolute(env.LOCAL_PRIVATE_STORAGE_DIR))
    fail('LOCAL_PRIVATE_STORAGE_DIR', 'Expected an absolute path');
  if (!isAbsolute(env.LOCAL_CATALOG_STORAGE_DIR))
    fail('LOCAL_CATALOG_STORAGE_DIR', 'Expected an absolute path');
  if (
    origins.length === 0 ||
    origins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    fail('CORS_ALLOWED_ORIGINS', 'Expected comma-separated HTTP(S) origins without paths');
  if (env.AUTH_PROVIDER === 'cognito')
    need([
      'COGNITO_CUSTOMER_POOL_ID',
      'COGNITO_CUSTOMER_CLIENT_ID',
      'COGNITO_WORKFORCE_POOL_ID',
      'COGNITO_RIDER_CLIENT_ID',
      'COGNITO_STORE_CLIENT_ID',
      'COGNITO_ADMIN_CLIENT_ID',
    ]);
  if (env.AUTH_PROVIDER === 'local' && env.LOCAL_JWT_SECRET.length < 16)
    fail('LOCAL_JWT_SECRET', 'Must be at least 16 characters');
  if (env.PAYMENTS_PROVIDER === 'razorpay')
    need(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']);
  if (env.MAPS_PROVIDER === 'ola') need(['OLA_MAPS_API_KEY', 'OLA_MAPS_BASE_URL']);
  for (const key of [
    'OLA_MAPS_AUTOCOMPLETE_PATH',
    'OLA_MAPS_DETAILS_PATH',
    'OLA_MAPS_GEOCODE_PATH',
    'OLA_MAPS_REVERSE_PATH',
    'OLA_MAPS_DIRECTIONS_PATH',
    'OLA_MAPS_MATRIX_PATH',
  ] as const) {
    if (!/^\/(?!\/)(?!.*\.\.)[A-Za-z0-9/_-]+$/.test(env[key]))
      fail(key, 'Must be a relative path without query or traversal');
  }
  if (env.MAPS_PROVIDER === 'ola') {
    try {
      const mapsUrl = new URL(env.OLA_MAPS_BASE_URL);
      if (
        !['http:', 'https:'].includes(mapsUrl.protocol) ||
        mapsUrl.username ||
        mapsUrl.password ||
        mapsUrl.search ||
        mapsUrl.hash
      )
        fail('OLA_MAPS_BASE_URL', 'Expected a provider HTTP(S) base URL');
    } catch {
      fail('OLA_MAPS_BASE_URL', 'Expected a provider HTTP(S) base URL');
    }
  }
  if (env.STORAGE_PROVIDER === 's3') {
    need(['S3_MEDIA_BUCKET', 'S3_PRIVATE_BUCKET', 'CDN_BASE_URL']);
    if (env.S3_MEDIA_BUCKET === env.S3_PRIVATE_BUCKET)
      fail('S3_PRIVATE_BUCKET', 'Public media and private objects require separate buckets');
    for (const key of ['CDN_BASE_URL', 'S3_ENDPOINT'] as const) {
      if (!env[key]) continue;
      try {
        const parsed = new URL(env[key]);
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash
        )
          fail(key, 'Expected an HTTP(S) base URL without credentials, query or fragment');
      } catch {
        fail(key, 'Expected an HTTP(S) base URL');
      }
    }
  }
  if (env.EMAIL_PROVIDER === 'ses') need(['SES_FROM_ADDRESS']);
  if (env.PUSH_PROVIDER === 'fcm') need(['FCM_SERVICE_ACCOUNT_JSON_SECRET']);
  if (env.NODE_ENV === 'production') {
    for (const key of [
      'AUTH_PROVIDER',
      'PAYMENTS_PROVIDER',
      'MAPS_PROVIDER',
      'STORAGE_PROVIDER',
      'EMAIL_PROVIDER',
      'PUSH_PROVIDER',
    ] as const) {
      if (env[key] === 'local' || env[key] === 'fake' || env[key] === 'smtp')
        fail(key, 'Local and fake providers are forbidden in production');
    }
    if (
      origins.some(
        (origin) =>
          !origin.startsWith('https://') || /localhost|127\.0\.0\.1|\[::1\]/i.test(origin),
      )
    )
      fail('CORS_ALLOWED_ORIGINS', 'Production origins must be non-local HTTPS origins');
    need(['METRICS_BEARER_TOKEN']);
    need(['AWS_REGION']);
    if (!env.APP_BASE_URL.startsWith('https://'))
      fail('APP_BASE_URL', 'Production application URL requires HTTPS');
    if (env.CDN_BASE_URL && !env.CDN_BASE_URL.startsWith('https://'))
      fail('CDN_BASE_URL', 'Production CDN URL requires HTTPS');
    if (env.METRICS_BEARER_TOKEN.length < 32)
      fail('METRICS_BEARER_TOKEN', 'Must be at least 32 characters in production');
    if (env.RAZORPAY_KEY_ID.startsWith('rzp_test_'))
      fail('RAZORPAY_KEY_ID', 'Test keys are forbidden in production');
    if (!env.OLA_MAPS_BASE_URL.startsWith('https://'))
      fail('OLA_MAPS_BASE_URL', 'Production maps endpoint requires HTTPS');
    if (env.S3_ENDPOINT) fail('S3_ENDPOINT', 'Custom S3 endpoints are forbidden in production');
    for (const key of [
      'APP_BASE_URL',
      'DATABASE_URL',
      'REDIS_URL',
      'OLA_MAPS_BASE_URL',
      'CDN_BASE_URL',
    ] as const) {
      if (/localhost|127\.0\.0\.1|\[::1\]|localstack/i.test(env[key]))
        fail(key, 'Local endpoints are forbidden in production');
    }
  }
});

export type Env = z.infer<typeof envSchema>;
/** Parse the declared application keys while ignoring unrelated OS environment keys. */
export function readEnv(source: NodeJS.ProcessEnv): Env {
  const keys = Object.keys(envBaseSchema.shape);
  const input = Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  const result = envSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  return result.data;
}
