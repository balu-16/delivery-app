import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PLATFORM_REALTIME_REDIS } from '../../../platform/contracts/runtime.js';
import { REALTIME_GATEWAY } from '../../../platform/contracts/runtime.js';
import type { Json } from '../../../platform/database/database.js';
import { duplicateRedis } from '../../../platform/redis/redis.js';
import type { RealtimeGateway, RealtimeNamespace } from '../../../platform/realtime/realtime.js';
import type { NamespaceRegistryPort, RealtimeBroadcasts } from '../contracts/tracking.js';

const LOCATION_THROTTLE_MS = 3000;

/**
 * Holds the namespace handles registered by the dispatch realtime lifecycles
 * (/rider and /customer). Emissions no-op when the gateway or a namespace is
 * absent (metadata composition, worker role) — HTTP polling remains the
 * guaranteed fallback.
 */
export class NamespaceRegistry implements NamespaceRegistryPort {
  private namespaces = new Map<string, RealtimeNamespace>();
  register(handle: RealtimeNamespace): void {
    this.namespaces.set(handle.name, handle);
  }
  get(name: '/rider' | '/customer'): RealtimeNamespace | null {
    return this.namespaces.get(name) ?? null;
  }
}

const CHANNEL = 'delivery:realtime:events';

export class GatewayRealtimeBroadcasts implements RealtimeBroadcasts {
  private lastLocationEmit = new Map<string, number>();
  constructor(private readonly redis: Redis) {}
  private publish(
    audience: '/rider' | '/customer',
    room: string,
    event: string,
    payload: Json,
  ): void {
    void this.redis
      .publish(CHANNEL, JSON.stringify({ audience, room, event, payload }))
      .catch(() => undefined);
  }
  emitRiderEvent(riderId: string, event: string, payload: Json): void {
    this.publish('/rider', `user:${riderId}`, event, payload);
  }
  emitOrderEvent(orderId: string, event: string, payload: Json): void {
    this.publish('/customer', `order:${orderId}`, event, payload);
  }
  emitOrderLocation(orderId: string, payload: Json): void {
    const now = Date.now();
    if (now - (this.lastLocationEmit.get(orderId) ?? 0) < LOCATION_THROTTLE_MS) return;
    if (this.lastLocationEmit.size >= 10000) {
      for (const [key, at] of this.lastLocationEmit)
        if (now - at > 60000) this.lastLocationEmit.delete(key);
      if (this.lastLocationEmit.size >= 10000)
        this.lastLocationEmit.delete(this.lastLocationEmit.keys().next().value!);
    }
    this.lastLocationEmit.set(orderId, now);
    this.emitOrderEvent(orderId, 'rider.location', payload);
  }
}

@Injectable()
export class BroadcastsFactory implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private subscriber?: Redis;
  constructor(
    private readonly registry: NamespaceRegistry,
    @Inject(PLATFORM_REALTIME_REDIS) private readonly redis: Redis,
    @Optional() @Inject(REALTIME_GATEWAY) private readonly gateway?: RealtimeGateway,
  ) {}
  build(): RealtimeBroadcasts {
    return new GatewayRealtimeBroadcasts(this.redis);
  }
  async onApplicationBootstrap(): Promise<void> {
    if (!this.gateway) return;
    this.subscriber = await duplicateRedis(this.redis);
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (_channel, data) => {
      try {
        const message = JSON.parse(data) as {
          audience: '/rider' | '/customer';
          room: string;
          event: string;
          payload: Json;
        };
        if (
          (message.audience === '/rider' || message.audience === '/customer') &&
          typeof message.room === 'string' &&
          typeof message.event === 'string'
        )
          this.registry
            .get(message.audience)
            ?.emitLocalToRoom(message.room, message.event, message.payload);
      } catch {
        /* Ignore malformed publications. */
      }
    });
    await this.subscriber.subscribe(CHANNEL);
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.subscriber) await this.subscriber.quit();
  }
}
