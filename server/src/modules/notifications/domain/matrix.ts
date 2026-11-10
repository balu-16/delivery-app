import type {
  NotificationCategory,
  NotificationChannel,
  NotificationClass,
} from '../contracts/notifications.js';

/** Structural event input (compatible with the platform EventEnvelope). */
export interface MatrixEvent {
  eventType: string;
  aggregateId: string;
  aggregateVersion: string;
  payload: unknown;
}

/**
 * Event matrix: maps known outbox event types to a notification plan.
 * Producers own the payload schemas (ADR 0011). Unresolvable inputs yield
 * `null`; the consumer records errors for malformed known event types.
 * Recipient *resolution* strategies are executed by infrastructure:
 * USER (payload userId), ORDER_OWNER (payload orderId → orders.user_id),
 * STORE_MANAGERS (payload storeId), ADMINS (all active admin users).
 */
export type RecipientStrategy = 'USER' | 'ORDER_OWNER' | 'STORE_MANAGERS' | 'ADMINS';

export interface NotificationPlan {
  templateKey: string;
  category: NotificationCategory;
  class: NotificationClass;
  channels: readonly NotificationChannel[];
  recipients: RecipientStrategy;
  /** IDs and deep links only; never sensitive data (Section 26). */
  data: Record<string, string>;
  deepLink: string | null;
  pushPriority: 'HIGH' | 'NORMAL';
}

const UUID = /^[0-9a-f-]{36}$/i;
const ORDER_CHANNELS: readonly NotificationChannel[] = ['PUSH', 'INBOX'];
const MONEY_CHANNELS: readonly NotificationChannel[] = ['PUSH', 'EMAIL', 'INBOX'];

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}
function stringAt(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}
function uuidAt(payload: Record<string, unknown>, key: string): string | null {
  const value = stringAt(payload, key);
  return value && UUID.test(value) ? value : null;
}
function orderIdOf(payload: Record<string, unknown>): string | null {
  return uuidAt(payload, 'orderId');
}
function userIdOf(payload: Record<string, unknown>): string | null {
  return uuidAt(payload, 'userId');
}
function paiseToRupees(value: string | null): string {
  if (!value || !/^\d{1,12}$/.test(value)) return '';
  return `₹${Number(value) / 100}`;
}

function plan(
  templateKey: string,
  category: NotificationCategory,
  klass: NotificationClass,
  channels: readonly NotificationChannel[],
  recipients: RecipientStrategy,
  data: Record<string, string>,
  deepLink: string | null,
  pushPriority: 'HIGH' | 'NORMAL' = 'NORMAL',
): NotificationPlan {
  return {
    templateKey,
    category,
    class: klass,
    channels,
    recipients,
    data,
    deepLink,
    pushPriority,
  };
}

function orderPlan(
  templateKey: string,
  payload: Record<string, unknown>,
  extraData: Record<string, string> = {},
): NotificationPlan | null {
  const orderId = orderIdOf(payload);
  const userId = userIdOf(payload);
  const orderNumber = stringAt(payload, 'orderNumber') ?? '';
  if (!userId && !orderId) return null; // recipient unresolvable from the payload
  const data: Record<string, string> = { orderNumber, orderId: orderId ?? '', ...extraData };
  return plan(
    templateKey,
    'ORDER_UPDATES',
    'TRANSACTIONAL',
    ORDER_CHANNELS,
    userId ? 'USER' : 'ORDER_OWNER',
    data,
    orderId ? `/orders/${orderId}` : null,
  );
}

/** Pure matrix: unknown event types return null and are skipped gracefully. */
export function planForEvent(event: MatrixEvent): NotificationPlan | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  switch (event.eventType) {
    case 'ORDER_CONFIRMED': {
      const orderNumber = stringAt(payload, 'orderNumber') ?? '';
      const userId = userIdOf(payload);
      const orderId = orderIdOf(payload);
      if (!userId || !orderId) return null;
      return plan(
        'order.confirmed',
        'ORDER_UPDATES',
        'TRANSACTIONAL',
        MONEY_CHANNELS,
        'USER',
        { orderNumber, orderId },
        `/orders/${orderId}`,
      );
    }
    case 'picking.task_changed': {
      const status = stringAt(payload, 'status');
      if (status === 'IN_PROGRESS') return orderPlan('order.picking', payload);
      if (status === 'ASSIGNED' || status === 'PENDING') return null; // internal transition
      return null;
    }
    case 'ORDER_PACKED':
      return orderPlan('order.packed', payload);
    case 'picking.task_completed':
      return null; // Packing metadata has its own committed transition.
    case 'ORDER_OUT_FOR_DELIVERY':
      return orderPlan('order.out_for_delivery', payload);
    case 'ORDER_DELIVERED':
      return orderPlan('order.delivered', payload);
    case 'ORDER_CANCELLED':
      return orderPlan('order.cancelled', payload);
    case 'delivery.completed':
      return null; // ORDER_DELIVERED is the customer-facing transition.
    case 'picking.item_changed':
      if (payload['status'] === 'SHORT') return orderPlan('item.short', payload);
      if (payload['status'] === 'SUBSTITUTED') return orderPlan('item.substituted', payload);
      return null;
    case 'delivery.failed':
      return orderPlan('order.delivery_failed', payload);
    case 'payments.funding.failed': {
      // Producer payload carries no userId; resolve the order owner or skip.
      const orderId = orderIdOf(payload);
      if (!orderId) return null;
      return plan(
        'payment.failed',
        'PAYMENTS',
        'TRANSACTIONAL',
        MONEY_CHANNELS,
        'ORDER_OWNER',
        { orderId, orderNumber: '' },
        `/orders/${orderId}`,
      );
    }
    case 'payments.refund.settled': {
      const userId = userIdOf(payload);
      const orderId = orderIdOf(payload);
      if (!userId) return null;
      return plan(
        'refund.processed',
        'PAYMENTS',
        'TRANSACTIONAL',
        MONEY_CHANNELS,
        'USER',
        {
          orderId: orderId ?? '',
          orderNumber: '',
          amount: paiseToRupees(stringAt(payload, 'amountPaise')),
        },
        orderId ? `/orders/${orderId}` : '/wallet',
      );
    }
    case 'payments.topup.captured': {
      const userId = userIdOf(payload);
      if (!userId) return null;
      return plan(
        'wallet.topup',
        'WALLET',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'USER',
        { amount: paiseToRupees(stringAt(payload, 'amountPaise')) },
        '/wallet',
      );
    }
    case 'payments.refund.initiated':
    case 'wallet.low_balance':
    case 'subscription.reminder':
    case 'subscription.low_balance':
    case 'subscription.price_increase':
    case 'subscription.skipped': {
      const userId = userIdOf(payload);
      if (!userId) return null;
      const templateKey =
        event.eventType === 'payments.refund.initiated'
          ? 'refund.initiated'
          : event.eventType === 'wallet.low_balance'
            ? 'wallet.low_balance'
            : event.eventType === 'subscription.reminder'
              ? 'subscription.reminder'
              : event.eventType === 'subscription.low_balance'
                ? 'subscription.low_balance'
                : event.eventType === 'subscription.price_increase'
                  ? 'subscription.price_increase'
                  : 'subscription.skipped';
      return plan(
        templateKey,
        event.eventType.startsWith('payments.') ? 'PAYMENTS' : 'WALLET',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'USER',
        {
          orderId: orderIdOf(payload) ?? '',
          subscriptionId: stringAt(payload, 'subscriptionId') ?? '',
          amount: paiseToRupees(stringAt(payload, 'amountPaise')),
        },
        event.eventType.startsWith('subscription.') ? '/subscriptions' : '/wallet',
      );
    }
    case 'delivery.wrong_address_flagged': {
      const orderId = orderIdOf(payload);
      if (!orderId || !uuidAt(payload, 'flagId')) return null;
      return plan(
        'admin.operational_alert',
        'ADMIN',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'ADMINS',
        { kind: event.eventType, aggregateId: orderId },
        `/admin/orders/${orderId}`,
        'HIGH',
      );
    }
    case 'custody.escalated':
    case 'ops.anomaly':
    case 'payments.refund.failed':
    case 'payments.webhook.failed':
    case 'outbox.lag_high':
    case 'subscription.generation_incomplete':
    case 'store.capacity_breached':
      return plan(
        'admin.operational_alert',
        'ADMIN',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'ADMINS',
        { kind: event.eventType, aggregateId: event.aggregateId },
        '/admin',
        'HIGH',
      );
    case 'inventory.low_stock': {
      const storeId = uuidAt(payload, 'storeId');
      if (!storeId) return null;
      return plan(
        'store.low_stock',
        'STORE_OPS',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'STORE_MANAGERS',
        {
          storeId,
          variantId: stringAt(payload, 'variantId') ?? '',
          available: stringAt(payload, 'available') ?? '',
        },
        `/stores/${storeId}/inventory`,
      );
    }
    case 'inventory.expiry_soon': {
      const storeId = uuidAt(payload, 'storeId');
      if (!storeId) return null;
      return plan(
        'store.expiring_batch',
        'STORE_OPS',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'STORE_MANAGERS',
        {
          storeId,
          variantId: stringAt(payload, 'variantId') ?? '',
          batchId: stringAt(payload, 'batchId') ?? '',
        },
        `/stores/${storeId}/inventory`,
      );
    }
    case 'picking.sla_breached': {
      const storeId = uuidAt(payload, 'storeId');
      if (!storeId) return null;
      return plan(
        'store.sla_breached',
        'STORE_OPS',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'STORE_MANAGERS',
        { storeId, orderId: stringAt(payload, 'orderId') ?? '' },
        `/stores/${storeId}/sla`,
      );
    }
    case 'dispatch.no_rider': {
      // Admin alert; a payload userId/orderId is only used for the message text.
      const orderId = orderIdOf(payload);
      return plan(
        'admin.no_riders',
        'ADMIN',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'ADMINS',
        { orderId: orderId ?? '' },
        orderId ? `/orders/${orderId}` : '/admin/dispatch',
        'HIGH',
      );
    }
    case 'reconciliation.finding': {
      return plan(
        'admin.reconciliation',
        'ADMIN',
        'TRANSACTIONAL',
        ORDER_CHANNELS,
        'ADMINS',
        {
          kind: stringAt(payload, 'kind') ?? '',
          aggregateType: stringAt(payload, 'aggregateType') ?? '',
          aggregateId: stringAt(payload, 'aggregateId') ?? '',
        },
        '/admin/reconciliation',
        'HIGH',
      );
    }
    case 'marketing.campaign': {
      // Promotional class: preferences and quiet hours both apply.
      const userId = userIdOf(payload);
      if (!userId) return null;
      return plan(
        'promotions.offer',
        'PROMOTIONS',
        'PROMOTIONAL',
        ORDER_CHANNELS,
        'USER',
        { detail: stringAt(payload, 'detail') ?? '' },
        '/offers',
      );
    }
    default:
      return tolerantRiderPlan(event.eventType, payload);
  }
}

/**
 * Rider events (P8 owns exact names): high-priority push for offers,
 * document review outcomes tolerant by prefix so P8 naming variants notify.
 */
function tolerantRiderPlan(
  eventType: string,
  payload: Record<string, unknown>,
): NotificationPlan | null {
  const userId = userIdOf(payload) ?? uuidAt(payload, 'riderId');
  const data = { reason: stringAt(payload, 'reason') ?? '' };
  if (
    eventType === 'rider.offer_created' ||
    eventType === 'dispatch.rider_offer_created' ||
    eventType === 'dispatch.offer_created'
  )
    return userId
      ? plan(
          'rider.offer',
          'RIDING',
          'TRANSACTIONAL',
          ['PUSH', 'INBOX'],
          'USER',
          data,
          '/rider/offers',
          'HIGH',
        )
      : null;
  if (
    eventType === 'rider.offer_revoked' ||
    eventType === 'dispatch.rider_offer_revoked' ||
    eventType === 'dispatch.offer_revoked'
  )
    return userId
      ? plan(
          'rider.offer_revoked',
          'RIDING',
          'TRANSACTIONAL',
          ['PUSH', 'INBOX'],
          'USER',
          data,
          '/rider/offers',
        )
      : null;
  if (eventType === 'rider.document.approved' || eventType === 'identity.rider_document_approved')
    return userId
      ? plan(
          'rider.document.approved',
          'RIDING',
          'TRANSACTIONAL',
          ['PUSH', 'INBOX'],
          'USER',
          data,
          '/rider/documents',
        )
      : null;
  if (eventType === 'rider.document.rejected' || eventType === 'identity.rider_document_rejected')
    return userId
      ? plan(
          'rider.document.rejected',
          'RIDING',
          'TRANSACTIONAL',
          ['PUSH', 'INBOX'],
          'USER',
          data,
          '/rider/documents',
        )
      : null;
  if (eventType.startsWith('rider.') || eventType.startsWith('dispatch.')) return null; // known producer family, unmapped variant: skip without failing
  return null;
}
