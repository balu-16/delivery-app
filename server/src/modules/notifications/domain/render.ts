import type { NotificationLocale } from '../contracts/notifications.js';

const PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}\}/g;

function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER.source, 'g');
}

/**
 * Replaces {{name}} placeholders; unknown placeholders render empty so
 * payload shape changes can never leak template syntax to users.
 */
export function renderTemplate(body: string, data: Record<string, string>): string {
  return body.replace(placeholderPattern(), (_match, key: string) => {
    const value = data[key];
    return value === undefined ? '' : String(value).slice(0, 500);
  });
}

/**
 * Matrix-permitted data keys per template (customize2 §3E): the union of the
 * data keys the event matrix supplies for that template key. The editor,
 * preview and send-time validation all check placeholders against this.
 */
export function permittedPlaceholders(templateKey: string): ReadonlySet<string> {
  const perKey: Record<string, readonly string[]> = {
    'order.confirmed': ['orderNumber', 'orderId'],
    'order.picking': ['orderNumber', 'orderId'],
    'order.packed': ['orderNumber', 'orderId'],
    'order.out_for_delivery': ['orderNumber', 'orderId'],
    'order.delivered': ['orderNumber', 'orderId'],
    'order.cancelled': ['orderNumber', 'orderId'],
    'order.delivery_failed': ['orderNumber', 'orderId'],
    'item.short': ['orderNumber', 'orderId', 'detail'],
    'item.substituted': ['orderNumber', 'orderId', 'detail'],
    'payment.failed': ['orderId', 'orderNumber'],
    'refund.processed': ['orderId', 'orderNumber', 'amount'],
    'wallet.topup': ['amount'],
    'refund.initiated': ['orderId', 'subscriptionId', 'amount'],
    'wallet.low_balance': ['orderId', 'subscriptionId', 'amount'],
    'subscription.reminder': ['orderId', 'subscriptionId', 'amount'],
    'subscription.low_balance': ['orderId', 'subscriptionId', 'amount'],
    'subscription.price_increase': ['orderId', 'subscriptionId', 'amount'],
    'subscription.skipped': ['orderId', 'subscriptionId', 'amount'],
    'admin.operational_alert': ['kind', 'aggregateId'],
    'store.low_stock': ['storeId', 'variantId', 'available'],
    'store.expiring_batch': ['storeId', 'variantId', 'batchId'],
    'store.sla_breached': ['storeId', 'orderId'],
    'admin.no_riders': ['orderId'],
    'admin.reconciliation': ['kind', 'aggregateType', 'aggregateId'],
    'admin.dlq_growth': ['failed', 'suspended', 'eventErrors'],
    'promotions.offer': ['detail'],
    'agent.reply_ready': ['threadId'],
    'agent.needs_you': ['threadId'],
    'agent.run_failed': ['threadId'],
    'agent.reorder_nudge': ['variantId', 'productName'],
    'rider.offer': ['reason', 'offerId', 'expiresAt'],
    'rider.offer_revoked': ['reason'],
    'rider.document.approved': ['reason'],
    'rider.document.rejected': ['reason'],
    'store.new_order': ['orderNumber', 'orderId'],
  };
  return new Set(perKey[templateKey] ?? []);
}

/** Extracts placeholder keys from subject and body text. */
export function extractPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(placeholderPattern())) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/** Sample data for preview: every permitted key gets a readable sample value. */
export function sampleDataFor(templateKey: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of permittedPlaceholders(templateKey)) {
    data[key] =
      key === 'amount' ||
      key === 'available' ||
      key === 'failed' ||
      key === 'suspended' ||
      key === 'eventErrors'
        ? '₹1'
        : key.toLowerCase().includes('id')
          ? key.slice(0, 3).toUpperCase() + '-1234'
          : 'example';
  }
  if (templateKey === 'agent.reorder_nudge') data['productName'] = 'Whole Milk (500 ml)';
  if (templateKey === 'order.confirmed' || templateKey.startsWith('order.'))
    data['orderNumber'] = 'ORD-1234';
  return data;
}

/**
 * Validates placeholders in subject/body against the matrix-permitted keys.
 * Returns the unknown keys (empty when valid). Empty text always passes.
 */
export function validatePlaceholders(
  templateKey: string,
  subject: string,
  body: string,
): { unknown: string[] } {
  const permitted = permittedPlaceholders(templateKey);
  const unknown = new Set<string>();
  for (const key of [...extractPlaceholders(subject), ...extractPlaceholders(body)]) {
    if (!permitted.has(key)) unknown.add(key);
  }
  return { unknown: [...unknown].sort() };
}

/** Locale fallback: the requested locale when supported, else 'en'. */
export function resolveLocale(requested: string | null | undefined): NotificationLocale {
  return requested === 'hi' || requested === 'te' ? requested : 'en';
}

export interface TemplateRow {
  templateKey: string;
  locale: NotificationLocale;
  channel: string;
  subject: string;
  body: string;
}

/**
 * Picks (key, channel, locale) and falls back to the 'en' row for the same
 * key+channel; falls back across channels only as a last resort (INBOX row)
 * so a missing channel seed never fails delivery.
 */
export function selectTemplate(
  templates: readonly TemplateRow[],
  key: string,
  channel: string,
  locale: NotificationLocale,
): TemplateRow | null {
  const forChannel = (row: TemplateRow) => row.templateKey === key && row.channel === channel;
  return (
    templates.find((row) => forChannel(row) && row.locale === locale) ??
    templates.find((row) => forChannel(row) && row.locale === 'en') ??
    templates.find(
      (row) => row.templateKey === key && row.channel === 'INBOX' && row.locale === 'en',
    ) ??
    null
  );
}
