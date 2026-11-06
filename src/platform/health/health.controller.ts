import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { READINESS_PROBES, type ReadinessProbe } from './contracts.js';

@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(@Inject(READINESS_PROBES) private readonly probes: readonly ReadinessProbe[]) {}
  @Get('healthz') live(): { status: string } {
    return { status: 'ok' };
  }
  @Get('readyz') async ready(): Promise<{ status: string }> {
    if (this.probes.length === 0) throw new ServiceUnavailableException();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        Promise.allSettled(this.probes.map((probe) => probe.check())),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), 3000);
        }),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new ServiceUnavailableException();
    } catch {
      throw new ServiceUnavailableException();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return { status: 'ok' };
  }
}
