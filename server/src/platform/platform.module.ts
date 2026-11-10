import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { SQSClient } from '@aws-sdk/client-sqs';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '../config/config.service.js';
import { createS3Client } from '../adapters/storage/s3-client.js';
import type { Env } from '../config/env.schema.js';
import { createLogger } from '../common/logging/logger.js';
import {
  PLATFORM_CONCERN_QUEUES,
  PLATFORM_DATABASE,
  PLATFORM_QUEUE,
  PLATFORM_REDIS,
  PLATFORM_REALTIME_REDIS,
  PLATFORM_SQS,
} from './contracts/runtime.js';
import { PLATFORM_RATE_LIMITER } from './contracts/rate-limit.js';
import { createDatabase, type DatabaseHandle } from './database/database.js';
import { READINESS_PROBES, type ReadinessProbe } from './health/contracts.js';
import type { DurableQueue } from './queue/queue.js';
import type { ConcernQueues } from './queue/concern-queues.js';
import { SqsEventQueue } from './queue/sqs-event-queue.js';
import { SqsConcernQueues } from './queue/sqs-concern-queues.js';
import { SQS_LANES, SqsTransport, type SqsQueueUrls } from './queue/sqs-transport.js';
import { createRedis, createIamRedis } from './redis/redis.js';
import { RedisRateLimiter } from './redis/rate-limiter.js';

@Injectable()
class PlatformLifecycle implements OnApplicationShutdown, OnApplicationBootstrap {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly database: DatabaseHandle,
    @Inject(PLATFORM_REDIS) private readonly redis: Redis,
    @Inject(PLATFORM_REALTIME_REDIS) private readonly realtimeRedis: Redis,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue | SqsEventQueue,
    @Inject(PLATFORM_CONCERN_QUEUES) private readonly concerns: ConcernQueues | SqsConcernQueues,
    @Inject(PLATFORM_SQS)
    private readonly sqs: { client: SQSClient; transport: SqsTransport } | null,
    @Inject('PLATFORM_WORKER_ENABLED') private readonly worker: boolean,
    @Inject('PLATFORM_OUTBOX_POLL_INTERVAL') private readonly pollInterval: number,
  ) {}
  onApplicationBootstrap(): void {
    if (this.worker) this.queue.startRecovery(this.pollInterval);
  }
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.concerns.close();
    } finally {
      try {
        await this.queue.close();
      } finally {
        try {
          if (this.redis.status === 'ready') await this.redis.quit();
          else this.redis.disconnect();
          if (this.realtimeRedis.status === 'ready') await this.realtimeRedis.quit();
          else this.realtimeRedis.disconnect();
        } finally {
          this.sqs?.client.destroy();
          await this.database.close();
        }
      }
    }
  }
}

@Injectable()
class MetadataLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly database: DatabaseHandle,
    @Inject(PLATFORM_REDIS) private readonly redis: Redis,
    @Inject(PLATFORM_REALTIME_REDIS) private readonly realtimeRedis: Redis,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    this.realtimeRedis.disconnect();
    await this.database.close();
  }
}

/** Isolate ephemeral test databases that share a Redis server. */
export function runtimeQueuePrefix(env: Pick<Env, 'NODE_ENV' | 'DATABASE_URL'>): string {
  if (env.NODE_ENV === 'test') {
    const database = new URL(env.DATABASE_URL).pathname.slice(1);
    const match = /^delivery_(?:test|p13)_([0-9a-f]{32})$/.exec(database);
    if (match) return `test:${match[1]}`;
  }
  return 'delivery';
}

/** Provider-only infrastructure module; surface controllers remain in role modules. */
@Global()
@Module({})
export class PlatformModule {
  /** Test/export composition: lazy database and Redis handles, no workers or network probes. */
  static forMetadata(env: Env, probes: ReadinessProbe[]): DynamicModule {
    if (env.NODE_ENV === 'production')
      throw new Error('Metadata-only composition is forbidden in production');
    return {
      module: PlatformModule,
      providers: [
        {
          provide: PLATFORM_DATABASE,
          useFactory: () =>
            createDatabase(
              env.DATABASE_URL,
              env.DATABASE_POOL_MAX,
              env.DATABASE_STATEMENT_TIMEOUT_MS,
              undefined,
              env.DB_ACQUIRE_TIMEOUT_MS,
              env.DATABASE_AUTH === 'iam' ? env.AWS_REGION : undefined,
            ),
        },
        {
          provide: PLATFORM_REDIS,
          useFactory: () => {
            const redis = createRedis(env.REDIS_URL);
            redis.on('error', () => undefined);
            return redis;
          },
        },
        {
          provide: PLATFORM_REALTIME_REDIS,
          useFactory: () => {
            const redis = createRedis(env.REDIS_URL);
            redis.on('error', () => undefined);
            return redis;
          },
        },
        {
          provide: PLATFORM_RATE_LIMITER,
          inject: [PLATFORM_REDIS],
          useFactory: (redis: Redis) => new RedisRateLimiter(redis, env, () => undefined),
        },
        { provide: READINESS_PROBES, useValue: probes },
        MetadataLifecycle,
      ],
      exports: [
        PLATFORM_DATABASE,
        PLATFORM_REDIS,
        PLATFORM_REALTIME_REDIS,
        PLATFORM_RATE_LIMITER,
        READINESS_PROBES,
      ],
    };
  }
  static forRoot(env: Env): DynamicModule {
    const logger = createLogger(env.LOG_LEVEL);
    const worker = env.APP_ROLE === 'all' || env.APP_ROLE === 'worker';
    return {
      module: PlatformModule,
      providers: [
        { provide: 'PLATFORM_WORKER_ENABLED', useValue: worker },
        { provide: 'PLATFORM_OUTBOX_POLL_INTERVAL', useValue: env.OUTBOX_POLL_INTERVAL_MS },
        {
          provide: PLATFORM_SQS,
          useFactory: () => {
            if (env.QUEUE_TRANSPORT !== 'sqs') return null;
            const prefix = env.SQS_QUEUE_PREFIX || 'delivery-dev';
            const client = new SQSClient({ region: env.AWS_REGION });
            const urls = Object.fromEntries(
              SQS_LANES.map((lane) => [
                lane,
                `https://sqs.${env.AWS_REGION}.amazonaws.com/${env.AWS_ACCOUNT_ID}/${prefix}-${lane}`,
              ]),
            ) as SqsQueueUrls;
            return {
              client,
              transport: new SqsTransport(client, urls, env.AWS_REGION, env.AWS_ACCOUNT_ID, prefix),
            };
          },
        },
        {
          provide: PLATFORM_DATABASE,
          useFactory: () =>
            createDatabase(
              env.DATABASE_URL,
              env.DATABASE_POOL_MAX,
              env.DATABASE_STATEMENT_TIMEOUT_MS,
              () => logger.error('Idle database connection failed'),
              env.DB_ACQUIRE_TIMEOUT_MS,
              env.DATABASE_AUTH === 'iam' ? env.AWS_REGION : undefined,
            ),
        },
        {
          provide: PLATFORM_REDIS,
          useFactory: async () => {
            const redis =
              env.CACHE_AUTH === 'elasticache-iam'
                ? await createIamRedis({
                    url: env.CACHE_URL,
                    cacheName: env.CACHE_IAM_NAME,
                    username: env.CACHE_IAM_USER,
                    region: env.AWS_REGION,
                  })
                : createRedis(env.REDIS_URL);
            redis.on('error', () => undefined);
            return redis;
          },
        },
        {
          provide: PLATFORM_REALTIME_REDIS,
          useFactory: async () => {
            const redis =
              env.CACHE_AUTH === 'elasticache-iam'
                ? await createIamRedis({
                    url: env.CACHE_URL,
                    cacheName: env.CACHE_IAM_NAME,
                    username: env.CACHE_IAM_USER,
                    region: env.AWS_REGION,
                  })
                : createRedis(env.REDIS_URL);
            redis.on('error', () => undefined);
            return redis;
          },
        },
        {
          provide: PLATFORM_RATE_LIMITER,
          inject: [PLATFORM_REDIS],
          useFactory: (redis: Redis) =>
            new RedisRateLimiter(redis, env, () =>
              logger.warn('Authenticated rate limiter unavailable'),
            ),
        },
        {
          provide: PLATFORM_CONCERN_QUEUES,
          inject: [PLATFORM_DATABASE, PLATFORM_SQS],
          useFactory: async (
            database: DatabaseHandle,
            sqs: { client: SQSClient; transport: SqsTransport } | null,
          ) => {
            if (sqs)
              return new SqsConcernQueues({
                db: database.db,
                transport: sqs.transport,
                consume: worker,
                concurrency: env.QUEUE_CONCURRENCY,
                onError: () => logger.error('Concern queue operation failed'),
              });
            const { ConcernQueues } = await import('./queue/concern-queues.js');
            return new ConcernQueues({
              redisUrl: env.REDIS_URL,
              prefix: runtimeQueuePrefix(env),
              consume: worker,
              concurrency: env.QUEUE_CONCURRENCY,
              onError: () => logger.error('Concern queue operation failed'),
            });
          },
        },
        {
          provide: PLATFORM_QUEUE,
          inject: [PLATFORM_DATABASE, PLATFORM_SQS],
          useFactory: async (
            database: DatabaseHandle,
            sqs: { client: SQSClient; transport: SqsTransport } | null,
          ) => {
            if (sqs)
              return new SqsEventQueue({
                db: database.db,
                transport: sqs.transport,
                consume: worker,
                concurrency: env.QUEUE_CONCURRENCY,
                onError: () => logger.error('Event queue operation failed'),
              });
            const { DurableQueue } = await import('./queue/queue.js');
            const queue = new DurableQueue({
              db: database.db,
              redisUrl: env.REDIS_URL,
              prefix: runtimeQueuePrefix(env),
              consume: worker,
              concurrency: env.QUEUE_CONCURRENCY,
              autorun: false,
              onError: () => logger.error('Queue operation failed'),
            });
            return queue;
          },
        },
        {
          provide: READINESS_PROBES,
          inject: [PLATFORM_DATABASE, PLATFORM_REDIS, PLATFORM_QUEUE, PLATFORM_CONCERN_QUEUES],
          useFactory: (
            database: DatabaseHandle,
            redis: Redis,
            queue: DurableQueue,
            concerns: ConcernQueues,
          ): ReadinessProbe[] => {
            const s3 =
              env.STORAGE_PROVIDER === 's3' ? createS3Client(new ConfigService(env)) : null;
            return [
              { name: 'database', check: () => database.ping() },
              {
                name: 'redis',
                check: async () => {
                  if ((await redis.ping()) !== 'PONG') throw new Error('Redis unavailable');
                },
              },
              { name: 'queue', check: () => queue.ping() },
              { name: 'concern-queues', check: () => concerns.ping() },
              ...(s3
                ? [
                    {
                      name: 's3',
                      check: async () => {
                        await Promise.all(
                          [env.S3_MEDIA_BUCKET!, env.S3_PRIVATE_BUCKET!].map((Bucket) =>
                            s3.send(new HeadBucketCommand({ Bucket }), {
                              abortSignal: AbortSignal.timeout(env.READINESS_TIMEOUT_MS),
                            }),
                          ),
                        );
                      },
                    },
                  ]
                : []),
            ];
          },
        },
        PlatformLifecycle,
      ],
      exports: [
        PLATFORM_DATABASE,
        PLATFORM_REDIS,
        PLATFORM_REALTIME_REDIS,
        PLATFORM_QUEUE,
        PLATFORM_CONCERN_QUEUES,
        PLATFORM_RATE_LIMITER,
        READINESS_PROBES,
      ],
    };
  }
}
