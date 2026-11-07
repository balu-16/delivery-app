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
import type { Env } from '../../config/env.schema.js';
import { createLogger } from '../../common/logging/logger.js';
import { REALTIME_GATEWAY } from '../contracts/runtime.js';
import { createRealtimeGateway, RealtimeGateway } from './realtime.js';

/**
 * One realtime gateway per process; audience namespaces are registered by the
 * phase modules that own them (P8). Metadata composition (OpenAPI export,
 * contract tests) never boots sockets.
 */
@Injectable()
class RealtimeLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private gateway: RealtimeGateway | null = null;
  private readonly logger = createLogger('info');
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject('REALTIME_ENV') private readonly env: Env,
  ) {}
  get gatewayHandle(): RealtimeGateway | null {
    return this.gateway;
  }
  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer();
    this.gateway = createRealtimeGateway({
      httpServer,
      redisUrl: this.env.REDIS_URL,
      prefix: 'delivery',
      drainMs: Math.min(5000, Math.max(0, this.env.SHUTDOWN_TIMEOUT_MS - 1000)),
      corsOrigins: this.env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
      onError: (error) => this.logger.error({ err: error.message }, 'Realtime error'),
    });
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
              const gateway = lifecycle.gatewayHandle;
              if (!gateway) throw new Error('REALTIME_UNAVAILABLE');
              return gateway.register(spec);
            },
          }),
        },
      ],
      exports: [REALTIME_GATEWAY],
    };
  }
}
