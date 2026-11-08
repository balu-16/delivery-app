import { planForEvent } from '../../../src/modules/notifications/domain/matrix.js';
import {
  chunkBounded,
  decodeCursor,
  encodeCursor,
} from '../../../src/modules/notifications/domain/cursor.js';
import type { EventEnvelope } from '../../../src/platform/outbox/outbox.js';

const uuid = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function event(eventType: string, payload: unknown, version = '1'): EventEnvelope {
  return {
    eventId: uuid(1),
    eventType,
    schemaVersion: 1,
    aggregateType: 'order',
    aggregateId: uuid(2),
    aggregateVersion: version,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(2),
    causationId: null,
    payload: payload as EventEnvelope['payload'],
  };
}

describe('event matrix', () => {
  it('alerts admins about an owned wrong-address flag with the order resolution link', () => {
    expect(
      planForEvent(
        event('delivery.wrong_address_flagged', {
          orderId: uuid(2),
          flagId: uuid(4),
          riderId: uuid(3),
        }),
      ),
    ).toMatchObject({
      templateKey: 'admin.operational_alert',
      recipients: 'ADMINS',
      deepLink: `/admin/orders/${uuid(2)}`,
    });
    expect(planForEvent(event('delivery.wrong_address_flagged', {}))).toBeNull();
  });
  it('maps ORDER_CONFIRMED to a transactional customer fan-out', () => {
    const plan = planForEvent(
      event('ORDER_CONFIRMED', {
        orderId: uuid(2),
        orderNumber: 'ORD-7',
        userId: uuid(3),
        storeId: uuid(4),
        targetDeliveryAt: new Date().toISOString(),
        items: [],
      }),
    );
    expect(plan).toMatchObject({
      templateKey: 'order.confirmed',
      recipients: 'USER',
      category: 'ORDER_UPDATES',
      class: 'TRANSACTIONAL',
      deepLink: `/orders/${uuid(2)}`,
    });
    expect(plan!.channels).toEqual(['PUSH', 'EMAIL', 'INBOX']);
    expect(plan!.data['orderNumber']).toBe('ORD-7');
  });

  it('maps picking transitions to packing/picking only for customer-visible states', () => {
    const base = { taskId: uuid(5), orderId: uuid(2), userId: uuid(3) };
    expect(
      planForEvent(event('picking.task_changed', { ...base, status: 'IN_PROGRESS' }))?.templateKey,
    ).toBe('order.picking');
    expect(planForEvent(event('picking.task_changed', { ...base, status: 'ASSIGNED' }))).toBeNull();
    expect(planForEvent(event('ORDER_PACKED', base))?.templateKey).toBe('order.packed');
  });

  it('resolves the order owner when the producer payload lacks userId', () => {
    const plan = planForEvent(
      event('payments.funding.failed', { orderId: uuid(2), attemptId: uuid(6) }),
    );
    expect(plan).toMatchObject({ templateKey: 'payment.failed', recipients: 'ORDER_OWNER' });
    expect(planForEvent(event('payments.funding.failed', { attemptId: uuid(6) }))).toBeNull();
  });

  it('requires a userId for refunds and topups and formats paise', () => {
    const plan = planForEvent(
      event('payments.refund.settled', {
        refundId: uuid(7),
        orderId: uuid(2),
        userId: uuid(3),
        amountPaise: '49900',
      }),
    );
    expect(plan).toMatchObject({ templateKey: 'refund.processed', recipients: 'USER' });
    expect(plan!.data['amount']).toBe('₹499');
    expect(planForEvent(event('payments.refund.settled', { refundId: uuid(7) }))).toBeNull();
    const topup = planForEvent(
      event('payments.topup.captured', { userId: uuid(3), amountPaise: '250' }),
    );
    expect(topup).toMatchObject({ templateKey: 'wallet.topup', class: 'TRANSACTIONAL' });
    expect(topup!.data['amount']).toBe('₹2.5');
  });

  it('routes store and admin operational alerts', () => {
    expect(
      planForEvent(
        event('inventory.low_stock', { storeId: uuid(4), variantId: uuid(8), available: '2' }),
      ),
    ).toMatchObject({ templateKey: 'store.low_stock', recipients: 'STORE_MANAGERS' });
    expect(
      planForEvent(
        event('inventory.expiry_soon', { storeId: uuid(4), variantId: uuid(8), batchId: uuid(9) }),
      ),
    ).toMatchObject({ templateKey: 'store.expiring_batch' });
    expect(
      planForEvent(
        event('picking.sla_breached', { taskId: uuid(5), orderId: uuid(2), storeId: uuid(4) }),
      ),
    ).toMatchObject({ templateKey: 'store.sla_breached', recipients: 'STORE_MANAGERS' });
    expect(planForEvent(event('dispatch.no_rider', { orderId: uuid(2) }))).toMatchObject({
      templateKey: 'admin.no_riders',
      recipients: 'ADMINS',
      pushPriority: 'HIGH',
    });
    expect(
      planForEvent(
        event('reconciliation.finding', {
          kind: 'DUPLICATE_CAPTURE',
          aggregateType: 'payment_attempt',
          aggregateId: uuid(6),
        }),
      ),
    ).toMatchObject({ templateKey: 'admin.reconciliation', recipients: 'ADMINS' });
  });

  it('treats delivery outcomes tolerantly', () => {
    expect(
      planForEvent(event('delivery.completed', { orderId: uuid(2), userId: uuid(3) })),
    ).toBeNull();
    expect(planForEvent(event('delivery.failed', { orderId: uuid(2) }))?.templateKey).toBe(
      'order.delivery_failed',
    );
    expect(planForEvent(event('delivery.failed', {}))).toBeNull();
  });

  it('handles rider events by tolerant name and skips unknown families', () => {
    expect(
      planForEvent(event('dispatch.rider_offer_created', { userId: uuid(3), offerId: uuid(10) })),
    ).toMatchObject({ templateKey: 'rider.offer', pushPriority: 'HIGH' });
    expect(planForEvent(event('dispatch.offer_revoked', { userId: uuid(3) }))?.templateKey).toBe(
      'rider.offer_revoked',
    );
    expect(
      planForEvent(event('rider.document.rejected', { userId: uuid(3), reason: 'blurry' }))!.data[
        'reason'
      ],
    ).toBe('blurry');
    expect(planForEvent(event('dispatch.rider_offer_created', { offerId: uuid(10) }))).toBeNull();
    expect(planForEvent(event('dispatch.future_thing', { userId: uuid(3) }))).toBeNull();
  });

  it('skips unknown event types and malformed payloads', () => {
    expect(
      planForEvent(event('catalog.product_publication_changed', { productId: uuid(8) })),
    ).toBeNull();
    expect(planForEvent(event('ORDER_DELIVERED', 'not-an-object'))).toBeNull();
    expect(planForEvent(event('ORDER_DELIVERED', { orderId: 'not-a-uuid' }))).toBeNull();
  });
});

describe('current producer contracts', () => {
  it('accepts rider IDs and pick-item transitions without duplicating delivered events', () => {
    expect(
      planForEvent(event('rider.offer_created', { riderId: uuid(2), offerId: uuid(3) })),
    ).toMatchObject({ templateKey: 'rider.offer', recipients: 'USER' });
    expect(
      planForEvent(event('rider.offer_revoked', { riderId: uuid(2), offerId: uuid(3) })),
    ).toMatchObject({ templateKey: 'rider.offer_revoked' });
    expect(
      planForEvent(event('picking.item_changed', { orderId: uuid(2), status: 'SHORT' })),
    ).toMatchObject({ templateKey: 'item.short' });
    expect(
      planForEvent(event('picking.item_changed', { orderId: uuid(2), status: 'SUBSTITUTED' })),
    ).toMatchObject({ templateKey: 'item.substituted' });
    expect(planForEvent(event('delivery.completed', { orderId: uuid(2) }))).toBeNull();
    expect(planForEvent(event('ORDER_DELIVERED', { orderId: uuid(2) }))).toMatchObject({
      templateKey: 'order.delivered',
    });
  });
});

describe('bounded batching and cursors', () => {
  it('chunks at or below 500 with a final partial batch', () => {
    const items = Array.from({ length: 1201 }, (_, index) => index);
    const batches = chunkBounded(items);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
    expect(chunkBounded([1, 2, 3], 2).map((batch) => batch.length)).toEqual([2, 1]);
    expect(chunkBounded([], 500)).toEqual([]);
    expect(() => chunkBounded([1], 501)).toThrow('INVALID_BATCH_SIZE');
    expect(() => chunkBounded([1], 0)).toThrow('INVALID_BATCH_SIZE');
  });
  it('round-trips inbox cursors and rejects tampering', () => {
    const created = new Date('2026-11-07T10:00:00.000Z');
    const cursor = encodeCursor(created, uuid(2));
    expect(decodeCursor(cursor)).toEqual({ createdAt: created, id: uuid(2) });
    expect(() => decodeCursor('!!!not-base64-url!!!')).toThrow('INVALID_CURSOR');
    expect(() => decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toThrow(
      'INVALID_CURSOR',
    );
    expect(() =>
      decodeCursor(Buffer.from(`${created.toISOString()}|nope`, 'utf8').toString('base64url')),
    ).toThrow('INVALID_CURSOR');
  });
});
