import { Global, Module } from '@nestjs/common';
import { HttpMetrics } from './http-metrics.js';

/** One bounded in-process collector shared by the HTTP and dependency layers. */
@Global()
@Module({ providers: [HttpMetrics], exports: [HttpMetrics] })
export class MetricsModule {}
