import { Module } from '@nestjs/common';
import { sql } from 'kysely';
import { uuidV7 } from '../../common/ids/ids.js';
import { appendEvent } from '../../platform/outbox/outbox.js';
import {
  ADDRESS_SUBSCRIPTIONS,
  SUBSCRIPTION_OBLIGATIONS,
  type AddressSubscriptions,
  type SubscriptionObligations,
} from './contracts/subscriptions.js';
const obligations: SubscriptionObligations = {
  async hasLiveObligations(userId, tx) {
    const result =
      await sql`SELECT 1 FROM subscriptions WHERE user_id=${userId}::uuid AND status IN ('ACTIVE','PAUSED') LIMIT 1`.execute(
        tx,
      );
    return result.rows.length > 0;
  },
};
const addresses: AddressSubscriptions = {
  async pauseForDeletedAddress(userId, addressId, tx) {
    const locked = await sql<{
      id: string;
    }>`SELECT id::text FROM subscriptions WHERE user_id=${userId}::uuid AND status='ACTIVE' AND (address_id=${addressId}::uuid OR EXISTS(SELECT 1 FROM subscription_schedule_versions v WHERE v.subscription_id=subscriptions.id AND v.address_id=${addressId}::uuid AND v.effective_from >= (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date)) ORDER BY id FOR UPDATE`.execute(
      tx,
    );
    for (const row of locked.rows) {
      await sql`UPDATE subscriptions SET status='PAUSED',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
        tx,
      );
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: 'subscription.skipped',
          schemaVersion: 1,
          aggregateType: 'subscription',
          aggregateId: row.id,
          aggregateVersion: '1',
          occurredAt: new Date().toISOString(),
          correlationId: row.id,
          causationId: null,
          payload: { userId, subscriptionId: row.id, reason: 'ADDRESS_DELETED' },
        },
        ['notifications'],
      );
    }
    return locked.rows.length;
  },
};
@Module({
  providers: [
    { provide: SUBSCRIPTION_OBLIGATIONS, useValue: obligations },
    { provide: ADDRESS_SUBSCRIPTIONS, useValue: addresses },
  ],
  exports: [SUBSCRIPTION_OBLIGATIONS, ADDRESS_SUBSCRIPTIONS],
})
export class SubscriptionObligationsModule {}
