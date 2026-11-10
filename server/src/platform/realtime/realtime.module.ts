import {
  BeforeApplicationShutdown,
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  type DynamicModule,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import type { Env } from '../../config/env.schema.js';
import { createLogger } from '../../common/logging/logger.js';
import { REALTIME_GATEWAY } from '../contracts/runtime.js';
import { createRealtimeGateway, RealtimeGateway } from './realtime.js';
import { createIamRedisCluster } from '../redis/iam-cluster.js';
import type { NamespaceSpec, RealtimeNamespace } from './realtime.js';

/**
 * One realtime gateway per process; audience namespaces are registered by the
 * phase modules that own them (P8). Metadata composition (OpenAPI export,
 * contract tests) never boots sockets.
 */
@Injectable()
class RealtimeLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private gateway: RealtimeGateway | null = null;
  private readonly logger = createLogger('info');
  private readonly pending: Array<() => void> = [];
  register(spec: NamespaceSpec): RealtimeNamespace {
    let handle: RealtimeNamespace | null = null;
    const register = () => {
      if (this.gateway) handle = this.gateway.register(spec);
    };
    if (this.gateway) register();
    else this.pending.push(register);
    return {
      name: spec.name,
      emitToRoom: (room, event, payload) => handle?.emitToRoom(room, event, payload),
      emitLocalToRoom: (room, event, payload) => handle?.emitLocalToRoom(room, event, payload),
      socketsIn: (room) => handle?.socketsIn(room) ?? 0,
    };
  }
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject('REALTIME_ENV') private readonly env: Env,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer();
    let adapter: Parameters<typeof createRealtimeGateway>[0]['adapter'];
    let closeAdapter: (() => Promise<void>) | undefined;
    let awaitAdapter: (() => Promise<void>) | undefined;
    if (this.env.CACHE_AUTH === 'elasticache-iam') {
      const config = {
        url: this.env.CACHE_URL,
        cacheName: this.env.CACHE_IAM_NAME,
        username: this.env.CACHE_IAM_USER,
        region: this.env.AWS_REGION,
      };
      const publisher = createIamRedisCluster(config);
      const subscriber = createIamRedisCluster(config);
      publisher.on('error', () => this.logger.error('Realtime cache publisher failed'));
      subscriber.on('error', () => this.logger.error('Realtime cache subscriber failed'));
      try {
        const connections = await Promise.allSettled([publisher.connect(), subscriber.connect()]);
        if (connections.some((result) => result.status === 'rejected'))
          throw new Error('REALTIME_CACHE_INITIALIZATION_FAILED');
        const subscriptions = new Set<Promise<void>>();
        let subscriptionFailed = false;
        const subscribe = subscriber.sSubscribe.bind(subscriber);
        subscriber.sSubscribe = ((...args: Parameters<typeof subscribe>) => {
          const pending = subscribe(...args);
          subscriptions.add(pending);
          void pending.then(
            () => subscriptions.delete(pending),
            () => {
              subscriptions.delete(pending);
              subscriptionFailed = true;
            },
          );
          return pending;
        }) as typeof subscriber.sSubscribe;
        awaitAdapter = async () => {
          while (subscriptions.size) await Promise.all([...subscriptions]);
          if (subscriptionFailed) throw new Error('REALTIME_SUBSCRIPTION_FAILED');
        };
        closeAdapter = async () => {
          await Promise.allSettled([publisher.close(), subscriber.close()]);
        };
        adapter = createShardedAdapter(publisher, subscriber, {
          channelPrefix: 'delivery:realtime',
          subscriptionMode: 'static',
        });
      } catch {
        for (const client of [publisher, subscriber]) {
          try {
            if (client.isOpen) client.destroy();
          } catch {
            // Continue closing both clients if one is already disconnected.
          }
        }
        throw new Error('REALTIME_CACHE_INITIALIZATION_FAILED');
      }
    }
    this.gateway = createRealtimeGateway({
      httpServer,
      redisUrl: adapter ? undefined : this.env.REDIS_URL,
      adapter,
      closeAdapter,
      awaitAdapter,
      prefix: 'delivery',
      drainMs: Math.min(5000, Math.max(0, this.env.SHUTDOWN_TIMEOUT_MS - 1000)),
      maxConnectionsPerUser: this.env.SOCKET_MAX_CONNECTIONS_PER_USER,
      maxConnectionsPerNamespace: this.env.SOCKET_MAX_CONNECTIONS_PER_NAMESPACE,
      corsOrigins: this.env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
      onError: (error) => this.logger.error({ err: error.message }, 'Realtime error'),
    });
    for (const register of this.pending.splice(0)) register();
    if (!this.gateway) {
      await closeAdapter?.();
      throw new Error('REALTIME_GATEWAY_INITIALIZATION_FAILED');
    }
    try {
      await awaitAdapter?.();
    } catch {
      await this.gateway.close().catch(() => undefined);
      this.gateway = null;
      throw new Error('REALTIME_SUBSCRIPTION_FAILED');
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.gateway?.close();
  }
}

@Global()
@Module({})
export class RealtimeModule {
  /** Runtime composition only; never imported by forMetadata/export paths. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: RealtimeModule,
      providers: [
        { provide: 'REALTIME_ENV', useValue: env },
        RealtimeLifecycle,
        {
          provide: REALTIME_GATEWAY,
          inject: [RealtimeLifecycle],
          useFactory: (lifecycle: RealtimeLifecycle) => ({
            /** Register lazily so ordering with phase-module bootstrap is irrelevant. */
            register: (spec: Parameters<RealtimeGateway['register']>[0]) => {
              return lifecycle.register(spec);
            },
          }),
        },
      ],
      exports: [REALTIME_GATEWAY],
    };
  }
}
