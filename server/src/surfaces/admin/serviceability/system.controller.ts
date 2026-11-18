import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { ConfigService } from '../../../config/config.service.js';
import { READINESS_PROBES, type ReadinessProbe } from '../../../platform/health/contracts.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { ADMIN_CONFIG, type AdminConfig } from '../../../modules/app-config/contracts/config.js';
import {
  CONFIG_HISTORY,
  type ConfigHistory,
} from '../../../modules/app-config/contracts/history.js';

class ProbeView {
  @ApiProperty() name!: string;
  @ApiProperty() available!: boolean;
}
class AssistantHealthView {
  @ApiProperty({ type: Boolean, nullable: true }) enabled!: boolean | null;
  @ApiProperty() runtimeConfigured!: boolean;
  @ApiProperty() worker!: string;
}
class SystemHealthView {
  @ApiProperty({ type: [ProbeView] }) checks!: ProbeView[];
  @ApiProperty({ type: AssistantHealthView }) assistant!: AssistantHealthView;
  @ApiProperty() push!: string;
}
class SettingsHistoryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() actor!: string;
  @ApiProperty() action!: string;
  @ApiProperty() subject!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) details!: Record<string, unknown>;
  @ApiProperty() occurredAt!: string;
}
@Controller('v1/admin/system')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminSystemController {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: readonly ReadinessProbe[],
    private readonly runtime: ConfigService,
    @Inject(ADMIN_CONFIG) private readonly config: AdminConfig,
    @Inject(CONFIG_HISTORY) private readonly history: ConfigHistory,
  ) {}
  @Get('history')
  @ApiOkResponse({ type: SettingsHistoryView, isArray: true })
  @ApiOperation({ operationId: 'adminSettingsHistory' })
  historyList(@CurrentPrincipal() p: Principal) {
    return this.history.recent(p.userId);
  }
  @Get('health')
  @ApiOkResponse({ type: SystemHealthView })
  @ApiOperation({ operationId: 'adminSystemHealth' })
  async health(): Promise<{
    checks: ProbeView[];
    assistant: { enabled: boolean | null; runtimeConfigured: boolean; worker: string };
    push: string;
  }> {
    const timeout = Math.min(this.runtime.get('READINESS_TIMEOUT_MS'), 5000);
    const withinTimeout = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const checks = await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await withinTimeout(probe.check());
          return { name: probe.name, available: true };
        } catch {
          return { name: probe.name, available: false };
        }
      }),
    );
    const provider = this.runtime.get('LLM_PROVIDER');
    const keyConfigured =
      provider === 'nvidia'
        ? !!this.runtime.get('NVIDIA_API_KEY')
        : provider === 'google'
          ? !!this.runtime.get('GOOGLE_API_KEY')
          : provider === 'anthropic'
            ? !!this.runtime.get('ANTHROPIC_API_KEY')
            : provider === 'bedrock' || provider === 'fake' || !!this.runtime.get('OPENAI_API_KEY');
    const runtimeConfigured =
      this.runtime.get('AGENT_ENABLED') === 'true' &&
      !!provider &&
      (provider === 'fake'
        ? this.runtime.get('NODE_ENV') !== 'production'
        : !!this.runtime.get('LLM_MODEL') &&
          keyConfigured &&
          (provider !== 'openai_compatible' || !!this.runtime.get('LLM_BASE_URL'))) &&
      this.runtime.get('LANGSMITH_TRACING') !== 'true';
    const worker =
      this.runtime.get('AGENT_WORKER_IN_PROCESS') === 'true' ||
      ['all', 'worker'].includes(this.runtime.get('APP_ROLE'))
        ? 'configured in this process'
        : 'external worker status unknown';
    return {
      checks,
      assistant: {
        enabled: await withinTimeout(this.config.flag('agent_enabled')).catch(() => null),
        runtimeConfigured,
        worker,
      },
      push:
        this.runtime.get('PUSH_PROVIDER') === 'fcm'
          ? 'configured (delivery not checked)'
          : 'test provider',
    };
  }
}
