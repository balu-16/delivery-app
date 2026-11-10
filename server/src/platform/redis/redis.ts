import { Redis } from 'ioredis';
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

class Sha256 {
  private readonly hash: Hash | Hmac;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret));
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(bytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return this.hash.digest();
  }
}

function bytes(data: string | ArrayBuffer | ArrayBufferView): string | Buffer {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export interface IamCacheConfig {
  url: string;
  cacheName: string;
  username: string;
  region: string;
}

const duplicateFactories = new WeakMap<Redis, () => Promise<Redis>>();

/** Duplicate IAM connections with an independent token refresher. */
export async function duplicateRedis(redis: Redis): Promise<Redis> {
  const factory = duplicateFactories.get(redis);
  return factory ? factory() : redis.duplicate();
}

export async function elasticacheIamToken(config: IamCacheConfig): Promise<string> {
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: config.region,
    service: 'elasticache',
    sha256: Sha256,
  });
  const request = await signer.presign(
    {
      method: 'GET',
      protocol: 'https:',
      hostname: config.cacheName,
      path: '/',
      headers: { host: config.cacheName },
      query: { Action: 'connect', User: config.username, ResourceType: 'ServerlessCache' },
    },
    { expiresIn: 900 },
  );
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (value !== undefined && value !== null) query.append(key, value);
  }
  return `${config.cacheName}/?${query.toString()}`;
}

/** Refresh before expiry so reconnects use a current IAM token. The server disconnects
 * connections after 12 hours, at which point ioredis reconnects with the latest token. */
export async function createIamRedis(
  config: IamCacheConfig,
  issueToken: (config: IamCacheConfig) => Promise<string> = elasticacheIamToken,
): Promise<Redis> {
  const token = await issueToken(config);
  const redis = new Redis(config.url, {
    username: config.username,
    password: token,
    tls: { rejectUnauthorized: true },
    maxRetriesPerRequest: 1,
    connectTimeout: 10000,
    commandTimeout: 10000,
    lazyConnect: true,
  });
  duplicateFactories.set(redis, () => createIamRedis(config, issueToken));
  let refreshing = false;
  let refreshedAt = Date.now();
  const timer = setInterval(() => {
    if (refreshing || Date.now() - refreshedAt < 5 * 60_000) return;
    refreshing = true;
    void issueToken(config)
      .then((next) => {
        redis.options.password = next;
        refreshedAt = Date.now();
      })
      .catch(() => {
        // Retain the last token and retry on the next interval without exposing credentials.
      })
      .finally(() => {
        refreshing = false;
      });
  }, 60_000);
  timer.unref();
  redis.once('end', () => clearInterval(timer));
  return redis;
}

/** Own connection; call quit on normal shutdown. BullMQ connections are separate. */
export function createRedis(url: string): Redis {
  if (!url) throw new Error('REDIS_URL is required');
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 2000,
    lazyConnect: true,
  });
}
