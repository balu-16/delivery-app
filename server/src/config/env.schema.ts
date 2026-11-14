import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';

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
    TRUSTED_PROXY_CIDRS: optional,
    SHUTDOWN_TIMEOUT_MS: positiveInteger(15000),
    HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
    HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(3000),
    BUSINESS_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    AUTH_PROVIDER: z.enum(['local', 'cognito']).default('local'),
    PAYMENTS_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
    MAPS_PROVIDER: z.enum(['fake', 'ola']).default('fake'),
    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    EMAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),
    PUSH_PROVIDER: z.enum(['fake', 'fcm']).default('fake'),
    DATABASE_URL: url('postgres://app:app@localhost:5432/delivery'),
    DATABASE_AUTH: z.enum(['password', 'iam']).default('password'),
    DATABASE_POOL_MAX: positiveInteger(20),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(10000),
    DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(1).max(60000).default(5000),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(500),
    QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    QUEUE_TRANSPORT: z.enum(['bullmq', 'sqs']).default('bullmq'),
    SQS_QUEUE_PREFIX: optional,
    SOCKET_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).max(100).default(10),
    SOCKET_MAX_CONNECTIONS_PER_NAMESPACE: z.coerce.number().int().min(1).max(100000).default(10000),
    REDIS_URL: url('redis://localhost:6379'),
    CACHE_AUTH: z.enum(['url', 'elasticache-iam']).default('url'),
    CACHE_URL: optional,
    CACHE_IAM_NAME: optional,
    CACHE_IAM_USER: optional,
    LOCAL_JWT_SECRET: z.string().default('local-dev-only-change-me'),
    PICKING_HANDOVER_SECRET: z.string().default('picking-handover-local-dev-secret-v1'),
    PICKING_CODE_KEY_VERSION: z.coerce.number().int().positive().default(1),
    PICKING_CODE_KEYS_JSON: z.string().default('{}'),
    ADMIN_SESSION_KEYS_JSON: z.string().default('{}'),
    ADMIN_SESSION_KEY_VERSION: z.coerce.number().int().positive().default(1),
    ADMIN_SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).max(86400).default(28800),
    ADMIN_SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().min(300).max(2592000).default(604800),
    AWS_REGION: z.string().default('ap-south-1'),
    AWS_ACCOUNT_ID: optional,
    COGNITO_CUSTOMER_POOL_ID: optional,
    COGNITO_CUSTOMER_CLIENT_ID: optional,
    CUSTOMER_GROUP_SYNC_QUEUE_URL: optional,
    COGNITO_WORKFORCE_POOL_ID: optional,
    COGNITO_RIDER_CLIENT_ID: optional,
    COGNITO_STORE_CLIENT_ID: optional,
    COGNITO_ADMIN_CLIENT_ID: optional,
    COGNITO_TIMEOUT_MS: positiveInteger(3000),
    COGNITO_BREAKER_FAILURES: positiveInteger(5),
    COGNITO_BREAKER_COOLDOWN_MS: positiveInteger(30000),
    S3_MEDIA_BUCKET: optional,
    S3_PRIVATE_BUCKET: optional,
    AWS_S3_PROFILE: optional,
    S3_ENDPOINT: optional,
    CDN_BASE_URL: optional,
    // A server-selected store supplies indicative prices before an address is chosen.
    CATALOG_PREVIEW_STORE_ID: z.union([z.literal(''), z.string().uuid()]).default(''),
    SES_FROM_ADDRESS: optional,
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    FCM_SERVICE_ACCOUNT_JSON_SECRET: optional,
    FIREBASE_SERVICE_ACCOUNT_PATH: optional,
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
    RATE_LIMIT_WEBHOOK_PER_MIN: positiveInteger(1200),
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
  if (env.HTTP_HEADERS_TIMEOUT_MS > env.HTTP_REQUEST_TIMEOUT_MS)
    fail('HTTP_HEADERS_TIMEOUT_MS', 'Header deadline must not exceed the request receive deadline');
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
  if (env.TRUSTED_PROXY_CIDRS) {
    const networks = env.TRUSTED_PROXY_CIDRS.split(',');
    if (
      networks.some((network) => {
        const [address, prefix, ...extra] = network.trim().split('/');
        const family = address ? isIP(address) : 0;
        return (
          extra.length > 0 ||
          !family ||
          (prefix !== undefined &&
            (!/^\d{1,3}$/.test(prefix) ||
              Number(prefix) < 1 ||
              Number(prefix) > (family === 4 ? 32 : 128)))
        );
      })
    )
      fail('TRUSTED_PROXY_CIDRS', 'Expected explicit trusted proxy IP addresses or CIDR ranges');
  }
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
  if (env.CACHE_AUTH === 'elasticache-iam') {
    need(['CACHE_URL', 'CACHE_IAM_NAME', 'CACHE_IAM_USER', 'AWS_REGION']);
    try {
      const cache = new URL(env.CACHE_URL);
      if (
        cache.protocol !== 'rediss:' ||
        cache.username ||
        cache.password ||
        cache.search ||
        cache.hash ||
        (cache.pathname && cache.pathname !== '/')
      )
        fail('CACHE_URL', 'IAM cache requires a credential-free rediss URL');
    } catch {
      fail('CACHE_URL', 'IAM cache requires a credential-free rediss URL');
    }
  }
  if (env.QUEUE_TRANSPORT === 'sqs') {
    if (!/^[0-9]{12}$/.test(env.AWS_ACCOUNT_ID))
      fail('AWS_ACCOUNT_ID', 'SQS requires a 12-digit AWS account ID');
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(env.AWS_REGION))
      fail('AWS_REGION', 'Invalid SQS region');
    if (env.SQS_QUEUE_PREFIX && !/^[a-zA-Z0-9_-]{1,64}$/.test(env.SQS_QUEUE_PREFIX))
      fail('SQS_QUEUE_PREFIX', 'Invalid SQS queue prefix');
    if (
      env.NODE_ENV === 'production' &&
      (!env.SQS_QUEUE_PREFIX || /^delivery-dev(?:-|$)/i.test(env.SQS_QUEUE_PREFIX))
    )
      fail('SQS_QUEUE_PREFIX', 'Production requires an explicit non-development SQS queue prefix');
  }
  if (env.CUSTOMER_GROUP_SYNC_QUEUE_URL) {
    try {
      const queue = new URL(env.CUSTOMER_GROUP_SYNC_QUEUE_URL);
      if (
        env.AUTH_PROVIDER !== 'cognito' ||
        !/^[0-9]{12}$/.test(env.AWS_ACCOUNT_ID) ||
        queue.protocol !== 'https:' ||
        queue.hostname !== `sqs.${env.AWS_REGION}.amazonaws.com` ||
        queue.port ||
        queue.username ||
        queue.password ||
        queue.search ||
        queue.hash ||
        !new RegExp(`^/${env.AWS_ACCOUNT_ID}/[a-zA-Z0-9_-]{1,80}$`).test(queue.pathname)
      )
        throw new Error('Invalid queue');
    } catch {
      fail(
        'CUSTOMER_GROUP_SYNC_QUEUE_URL',
        'Expected an SQS queue in the configured AWS region and account',
      );
    }
  }
  if (env.DATABASE_AUTH === 'iam') {
    need(['AWS_REGION']);
    try {
      const database = new URL(env.DATABASE_URL);
      if (
        !database.username ||
        database.password ||
        database.search ||
        database.hash ||
        database.pathname === '/'
      )
        fail(
          'DATABASE_URL',
          'IAM database requires a username and database, without password or URL options',
        );
    } catch {
      fail('DATABASE_URL', 'Invalid IAM database URL');
    }
  }
  if (env.AUTH_PROVIDER === 'local' && env.LOCAL_JWT_SECRET.length < 16)
    fail('LOCAL_JWT_SECRET', 'Must be at least 16 characters');
  try {
    const ring: unknown = JSON.parse(env.PICKING_CODE_KEYS_JSON);
    if (
      !ring ||
      typeof ring !== 'object' ||
      Array.isArray(ring) ||
      Object.entries(ring).some(
        ([k, v]) =>
          !/^[1-9]\d*$/.test(k) ||
          typeof v !== 'string' ||
          v.length < (env.NODE_ENV === 'production' ? 32 : 16),
      )
    )
      fail('PICKING_CODE_KEYS_JSON', 'Expected positive key versions mapped to secrets');
    if (
      env.PICKING_CODE_KEY_VERSION !== 1 &&
      !(String(env.PICKING_CODE_KEY_VERSION) in (ring as object))
    )
      fail('PICKING_CODE_KEY_VERSION', 'Current version must exist in the key ring');
  } catch {
    fail('PICKING_CODE_KEYS_JSON', 'Invalid code key ring');
  }
  try {
    const ring: unknown = JSON.parse(env.ADMIN_SESSION_KEYS_JSON);
    const entries =
      ring !== null && typeof ring === 'object' && !Array.isArray(ring)
        ? Object.entries(ring as Record<string, unknown>)
        : null;
    const wellFormed =
      entries !== null &&
      entries.every(([k, v]) => {
        if (!/^[1-9]\d*$/.test(k) || typeof v !== 'string') return false;
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      });
    if (env.NODE_ENV === 'production') {
      if (entries === null || !wellFormed || entries.length === 0)
        fail(
          'ADMIN_SESSION_KEYS_JSON',
          'Required in production: positive key versions mapped to base64 32-byte AES-256 secrets',
        );
      else if (Object.values(ring as Record<string, string>).some((value) => value.length < 32))
        fail(
          'ADMIN_SESSION_KEYS_JSON',
          'Production session secrets must be at least 32 characters',
        );
      else if (!Object.hasOwn(ring as object, String(env.ADMIN_SESSION_KEY_VERSION)))
        fail('ADMIN_SESSION_KEY_VERSION', 'Current version must exist in the session key ring');
    } else if (entries !== null && entries.length > 0) {
      if (!wellFormed)
        fail(
          'ADMIN_SESSION_KEYS_JSON',
          'Expected positive key versions mapped to base64 32-byte AES-256 secrets',
        );
      else if (!Object.hasOwn(ring as object, String(env.ADMIN_SESSION_KEY_VERSION)))
        fail('ADMIN_SESSION_KEY_VERSION', 'Current version must exist in the session key ring');
    }
  } catch {
    fail('ADMIN_SESSION_KEYS_JSON', 'Invalid session key ring');
  }
  if (env.ADMIN_SESSION_IDLE_SECONDS > env.ADMIN_SESSION_ABSOLUTE_SECONDS)
    fail('ADMIN_SESSION_IDLE_SECONDS', 'Idle window must not exceed the absolute session window');
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
    need(['S3_MEDIA_BUCKET', 'S3_PRIVATE_BUCKET']);
    if (env.NODE_ENV === 'production') need(['CDN_BASE_URL']);
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
  if (env.PUSH_PROVIDER === 'fcm') {
    if (!env.FCM_SERVICE_ACCOUNT_JSON_SECRET && !env.FIREBASE_SERVICE_ACCOUNT_PATH)
      fail('FIREBASE_SERVICE_ACCOUNT_PATH', 'Firebase credentials are required');
    if (env.FCM_SERVICE_ACCOUNT_JSON_SECRET && env.FIREBASE_SERVICE_ACCOUNT_PATH)
      fail('FIREBASE_SERVICE_ACCOUNT_PATH', 'Choose one Firebase credential source');
  }
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
    if (
      env.PICKING_HANDOVER_SECRET.length < 32 ||
      env.PICKING_HANDOVER_SECRET.startsWith('picking-handover-local')
    )
      fail('PICKING_HANDOVER_SECRET', 'Production handover verifier key must be a real secret');
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
