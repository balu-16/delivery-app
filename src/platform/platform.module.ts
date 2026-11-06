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
import type { Env } from '../config/env.schema.js';
import { createLogger } from '../common/logging/logger.js';
import {
  PLATFORM_CONCERN_QUEUES,
  PLATFORM_DATABASE,
  PLATFORM_QUEUE,
  PLATFORM_REDIS,
} from './contracts/runtime.js';
import { PLATFORM_RATE_LIMITER } from './contracts/rate-limit.js';
import { createDatabase, type DatabaseHandle } from './database/database.js';
import { READINESS_PROBES, type ReadinessProbe } from './health/contracts.js';
import { DurableQueue } from './queue/queue.js';
import { ConcernQueues } from './queue/concern-queues.js';
import { createRedis } from './redis/redis.js';
import { RedisRateLimiter } from './redis/rate-limiter.js';

@Injectable()
class PlatformLifecycle implements OnApplicationShutdown, OnApplicationBootstrap {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly database: DatabaseHandle,
    @Inject(PLATFORM_REDIS) private readonly redis: Redis,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
    @Inject(PLATFORM_CONCERN_QUEUES) private readonly concerns: ConcernQueues,
    @Inject('PLATFORM_WORKER_ENABLED') private readonly worker: boolean,
  ) {}
  onApplicationBootstrap(): void {
    if (this.worker) this.queue.startRecovery();
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
        } finally {
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
  ) {}
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.database.close();
  }
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
          provide: PLATFORM_RATE_LIMITER,
          inject: [PLATFORM_REDIS],
          useFactory: (redis: Redis) => new RedisRateLimiter(redis, env, () => undefined),
        },
        { provide: READINESS_PROBES, useValue: probes },
        MetadataLifecycle,
      ],
      exports: [PLATFORM_DATABASE, PLATFORM_REDIS, PLATFORM_RATE_LIMITER, READINESS_PROBES],
    };
  }
  static forRoot(env: Env): DynamicModule {
    const logger = createLogger(env.LOG_LEVEL);
    const worker = env.APP_ROLE === 'all' || env.APP_ROLE === 'worker';
    return {
      module: PlatformModule,
      providers: [
        { provide: 'PLATFORM_WORKER_ENABLED', useValue: worker },
        {
          provide: PLATFORM_DATABASE,
          useFactory: () =>
            createDatabase(
              env.DATABASE_URL,
              env.DATABASE_POOL_MAX,
              env.DATABASE_STATEMENT_TIMEOUT_MS,
              () => logger.error('Idle database connection failed'),
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
          provide: PLATFORM_RATE_LIMITER,
          inject: [PLATFORM_REDIS],
          useFactory: (redis: Redis) =>
            new RedisRateLimiter(redis, env, () =>
              logger.warn('Authenticated rate limiter unavailable'),
            ),
        },
        {
          provide: PLATFORM_CONCERN_QUEUES,
          useFactory: () =>
            new ConcernQueues({
              redisUrl: env.REDIS_URL,
              consume: worker,
              onError: () => logger.error('Concern queue operation failed'),
            }),
        },
        {
          provide: PLATFORM_QUEUE,
          inject: [PLATFORM_DATABASE],
          useFactory: (database: DatabaseHandle) => {
            const queue = new DurableQueue({
              db: database.db,
              redisUrl: env.REDIS_URL,
              consume: worker,
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
          ): ReadinessProbe[] => [
            { name: 'database', check: () => database.ping() },
            {
              name: 'redis',
              check: async () => {
                if ((await redis.ping()) !== 'PONG') throw new Error('Redis unavailable');
              },
            },
            { name: 'queue', check: () => queue.ping() },
            { name: 'concern-queues', check: () => concerns.ping() },
          ],
        },
        PlatformLifecycle,
      ],
      exports: [
        PLATFORM_DATABASE,
        PLATFORM_REDIS,
        PLATFORM_QUEUE,
        PLATFORM_CONCERN_QUEUES,
        PLATFORM_RATE_LIMITER,
        READINESS_PROBES,
      ],
    };
  }
}
