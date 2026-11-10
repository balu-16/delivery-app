import { Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { ConfigService } from '../../../config/config.service.js';
import { PaymentsModule } from '../../../modules/payments/payments.module.js';
import {
  PAYMENT_WEBHOOKS,
  type PaymentWebhookIngest,
} from '../../../modules/payments/contracts/payments.js';
import { registerWebhookRoute } from './webhook-route.js';

/**
 * Customer payment webhooks (manifest row POST-v1-customer-webhooks-payments-
 * gateway). The route is public by design: the gateway authenticates with the
 * HMAC signature over the exact raw body. Rate limits keep the shared
 * fail-open per-IP behaviour, so ingress stays writable during Redis outages
 * (documented in webhook-route.ts). No AuthPolicy/IdentityGuard here.
 */
@Injectable()
class WebhookRouteRegistration implements OnApplicationBootstrap {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(PAYMENT_WEBHOOKS) private readonly webhooks: PaymentWebhookIngest,
    private readonly config: ConfigService,
  ) {}
  onApplicationBootstrap(): void {
    const instance = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (instance && typeof instance.route === 'function')
      registerWebhookRoute(instance, this.webhooks, this.config);
  }
}

@Module({
  imports: [PaymentsModule],
  providers: [WebhookRouteRegistration],
})
export class CustomerPaymentsSurfaceModule {}
