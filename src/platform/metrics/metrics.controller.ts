import { Controller, Get, Headers, NotFoundException, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../../config/config.service.js';
import { HttpMetrics } from './http-metrics.js';

@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpMetrics,
  ) {}
  @Get('metrics') metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const token = this.config.get('METRICS_BEARER_TOKEN');
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorization ?? '');
    if (!token || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new NotFoundException();
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(this.http.render());
  }
}
