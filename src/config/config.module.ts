import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from './config.service.js';
import type { Env } from './env.schema.js';

/** Bootstrapped once; values remain immutable for the lifetime of the process. */
@Global()
@Module({})
export class RuntimeConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: RuntimeConfigModule,
      providers: [{ provide: ConfigService, useValue: new ConfigService(env) }],
      exports: [ConfigService],
    };
  }
}
