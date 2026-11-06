import { type DynamicModule, Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { HealthController } from '../platform/health/health.controller.js';
import { type ReadinessProbe } from '../platform/health/contracts.js';
import { MetricsController } from '../platform/metrics/metrics.controller.js';
import { HttpMetrics } from '../platform/metrics/http-metrics.js';
import { PlatformModule } from '../platform/platform.module.js';
import {
  AdminSurfaceModule,
  CustomerSurfaceModule,
  RiderSurfaceModule,
  StoreSurfaceModule,
} from '../surfaces/surfaces.module.js';
import { StoresModule } from '../modules/stores/stores.module.js';
import { StoreSignalsScheduler } from './store-signals-scheduler.js';
import { IdentitySyncWorkerModule } from '../modules/identity/identity-worker.module.js';

export const surfaceModules = {
  customer: CustomerSurfaceModule,
  rider: RiderSurfaceModule,
  store: StoreSurfaceModule,
  admin: AdminSurfaceModule,
} as const;
export type Surface = keyof typeof surfaceModules;
export function surfacesFor(role: Env['APP_ROLE']): Surface[] {
  return role === 'all' ? ['customer', 'rider', 'store', 'admin'] : role === 'worker' ? [] : [role];
}

/** The composition root receives provider-only infrastructure; surface modules own controllers. */
@Module({})
export class RoleModule {
  static forRole(env: Env, probes?: ReadinessProbe[]): DynamicModule {
    const worker = !probes && (env.APP_ROLE === 'worker' || env.APP_ROLE === 'all');
    return {
      module: RoleModule,
      imports: [
        RuntimeConfigModule.forRoot(env),
        probes ? PlatformModule.forMetadata(env, probes) : PlatformModule.forRoot(env),
        ...(worker ? [StoresModule, IdentitySyncWorkerModule] : []),
        ...surfacesFor(env.APP_ROLE).map((surface) => surfaceModules[surface]),
      ],
      controllers: [HealthController, MetricsController],
      providers: worker ? [HttpMetrics, StoreSignalsScheduler] : [HttpMetrics],
    };
  }
}
