import type { AppConfig } from '../../app-config/contracts/config.js';

export const POLICY_TOPICS = [
  'delivery_fees',
  'refunds',
  'cancellation',
  'timings',
  'wallet',
  'subscriptions',
  'contact',
] as const;
export type PolicyTopic = (typeof POLICY_TOPICS)[number];

export function isPolicyTopic(value: string): value is PolicyTopic {
  return (POLICY_TOPICS as readonly string[]).includes(value);
}

function rupees(paise: string | number): string {
  const value = typeof paise === 'string' ? BigInt(paise || '0') : BigInt(Math.round(paise));
  return `₹${Number(value / 100n)}.${String(value % 100n).padStart(2, '0')}`;
}

/** Policy answers are composed from configured values, so amounts stay authoritative.
 * Topics without a configured rule answer honestly instead of inventing policy. */
export async function policyText(topic: PolicyTopic, config: AppConfig): Promise<string> {
  switch (topic) {
    case 'delivery_fees': {
      const [slabs, threshold, handling, smallThreshold, smallFee, surge, minOrder] =
        await Promise.all([
          config.get('deliveryFeeSlabs'),
          config.get('freeDeliveryThresholdPaise'),
          config.get('handlingFeePaise'),
          config.get('smallCartThresholdPaise'),
          config.get('smallCartFeePaise'),
          config.get('surgeFeePaise'),
          config.get('minOrderPaise'),
        ]);
      const slabsText = slabs
        .map(
          (slab) =>
            `${slab.maxOrderValuePaise ? `orders up to ${rupees(slab.maxOrderValuePaise)}` : 'larger orders'}: ${rupees(slab.feePaise)}`,
        )
        .join('; ');
      return [
        `Minimum order value is ${rupees(minOrder)}.`,
        `Delivery fees: ${slabsText}.`,
        `Orders of ${rupees(threshold)} or more after discounts get free delivery.`,
        `Handling fee is ${rupees(handling)}; orders under ${rupees(smallThreshold)} add a small-cart fee of ${rupees(smallFee)}.`,
        surge === '0'
          ? 'No surge fee is currently configured.'
          : `A surge fee of ${rupees(surge)} may apply at busy times.`,
      ].join(' ');
    }
    case 'refunds': {
      const destination = await config.get('refundDestinationPolicy');
      const where =
        destination === 'wallet'
          ? 'to your DairyDirect wallet'
          : destination === 'original_then_wallet'
            ? 'to the original payment method where possible, otherwise to your DairyDirect wallet'
            : 'to the original payment method where possible';
      return (
        'Refunds are reviewed against the order and item condition before they are approved. ' +
        `Approved refunds go ${where}. You can request a refund here in chat and I will raise it with our support team; ` +
        'the final decision and the refund itself are handled by support, not by this chat.'
      );
    }
    case 'cancellation':
      return (
        'Whether an order can still be cancelled depends on how far it has progressed. ' +
        'Ask me to cancel and I will check the current status; if cancellation is no longer possible I will tell you and can raise a support request instead. ' +
        'Any refund after cancellation follows the refund policy.'
      );
    case 'timings': {
      const [min, max] = await Promise.all([
        config.get('etaMinMinutes'),
        config.get('etaMaxMinutes'),
      ]);
      return (
        `Delivery typically takes about ${min}-${max} minutes once your order is confirmed, depending on your address and how busy the store is. ` +
        'The estimate is shown before you confirm the order. Online payment and maps are coming soon.'
      );
    }
    case 'wallet':
      return (
        'An existing DairyDirect wallet balance can be applied to an eligible order. ' +
        'This chat can show that balance. Adding money to the wallet is unavailable. ' +
        'Cash on delivery follows the eligibility rules at checkout. Online payment is coming soon.'
      );
    case 'subscriptions':
      return 'Subscription deliveries are not available right now. If that changes, the app and this chat will show it.';
    case 'contact':
      return (
        'You can ask me here to report an order issue or to bring in a human agent, and I will create a support request for you. ' +
        'For account topics like login details use the app screens; support requests created here reach the same team.'
      );
  }
}
