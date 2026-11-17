import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { AgentModule } from '../../../modules/agent/agent.module.js';
import { CustomerAgentController } from './customer.controller.js';

@Module({ imports: [IdentityModule, AgentModule], controllers: [CustomerAgentController] })
export class CustomerAgentSurfaceModule {}
