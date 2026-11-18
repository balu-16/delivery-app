import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { uuidV7 } from '../../../common/ids/ids.js';
import { performance } from 'node:perf_hooks';
import type { AgentCardType } from '../contracts/agent.js';

/** Customer-facing activity identifiers deliberately contain no internal tool names. */
export const AGENT_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  list_addresses: 'agent.activity.savedAddresses',
  search_products: 'agent.activity.findProducts',
  get_cart: 'agent.activity.viewCart',
  get_order_history_summary: 'agent.activity.usualItems',
  list_recent_orders: 'agent.activity.recentOrders',
  get_order_details: 'agent.activity.orderDetails',
  get_order_tracking: 'agent.activity.deliveryTracking',
  check_serviceability: 'agent.activity.deliveryAvailability',
  parse_and_validate_address: 'agent.activity.addressDetails',
  get_policy_text: 'agent.activity.policy',
  save_address: 'agent.activity.addressDetails',
  get_wallet_summary: 'agent.activity.wallet',
  set_cart_item_qty: 'agent.activity.updateCart',
  list_available_coupons: 'agent.activity.offers',
  clear_cart: 'agent.activity.emptyCart',
  select_address_for_order: 'agent.activity.selectAddress',
  report_order_issue: 'agent.activity.orderIssue',
  escalate_to_human: 'agent.activity.contactSupport',
  set_reorder_nudges: 'agent.activity.reminders',
  place_order: 'agent.activity.orderPreparation',
  cancel_order: 'agent.activity.cancellation',
  request_refund: 'agent.activity.refundRequest',
};
export function toolNameForActivity(label: string): string {
  return (
    Object.entries(AGENT_ACTIVITY_LABELS).find(([, value]) => value === label)?.[0] ??
    (label.startsWith('agent.tool.') ? label.slice('agent.tool.'.length) : 'unknown')
  );
}

const safeErrors = [
  'ADDRESS_REQUIRED',
  'ADDRESS_LOCATION_REQUIRED',
  'ADDRESS_SAVE_NOT_REQUESTED',
  'ADDRESS_NOT_FOUND',
  'ADDRESS_LIMIT_REACHED',
  'ORDER_NOT_FOUND',
  'CART_NOT_FOUND',
  'CART_NOT_READY',
  'ADDRESS_NOT_SERVICEABLE',
  'INVENTORY_INSUFFICIENT',
  'CONCURRENT_MODIFICATION',
  'INVALID_QUANTITY',
  'INVALID_PINCODE',
  'INVALID_CONTACT_PHONE',
  'QUOTE_EXPIRED',
  'COD_NOT_ELIGIBLE',
  'AGENT_ORDER_LIMIT',
  'THREAD_ARCHIVED',
  'RATE_LIMITED',
];
const issueCards: Readonly<
  Record<string, { type: AgentCardType; title: string; description: string }>
> = {
  INVENTORY_INSUFFICIENT: {
    type: 'out_of_stock',
    title: 'Availability changed',
    description: 'Some items may no longer be available. Review your cart to choose what to do.',
  },
  ADDRESS_NOT_SERVICEABLE: {
    type: 'delivery_unavailable',
    title: 'Delivery is unavailable here',
    description: 'Try another saved delivery address or check back later.',
  },
  COD_NOT_ELIGIBLE: {
    type: 'payment_unavailable',
    title: 'Cash on delivery is unavailable',
    description:
      'This order cannot currently be paid on delivery. Review your cart or contact support.',
  },
  CART_NOT_READY: {
    type: 'cart_attention',
    title: 'Your cart needs attention',
    description: 'Review your cart for changes before placing this order.',
  },
};
/** Shared validation, loop guard, status events and safe error envelope for tools. */
export class AgentToolKit {
  private count = 0;
  private totalToolMs = 0;
  private readonly calls = new Map<string, number>();
  private readonly shownCards = new Set<string>();
  constructor(private readonly maxCalls: number) {}
  /** Tool invocations so far in this run, for usage accounting. */
  get used(): number {
    return this.count;
  }
  /** Sum of handler durations; concurrent calls and database work can overlap. */
  get toolMs(): number {
    return this.totalToolMs;
  }
  showCardOnce(key: string): boolean {
    if (this.shownCards.has(key)) return false;
    this.shownCards.add(key);
    return true;
  }
  define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<S>,
    handler: (input: z.output<z.ZodObject<S>>, runtime: ToolRuntime) => Promise<unknown>,
  ) {
    return tool(
      async (input, runtime: ToolRuntime) => {
        this.count += 1;
        const fingerprint = `${name}:${JSON.stringify(input)}`;
        this.calls.set(fingerprint, (this.calls.get(fingerprint) ?? 0) + 1);
        if (this.count > this.maxCalls || (this.calls.get(fingerprint) ?? 0) > 2)
          return JSON.stringify({
            ok: false,
            error: { code: 'TOOL_LIMIT_REACHED', retryable: false },
          });
        const labelKey = AGENT_ACTIVITY_LABELS[name] ?? 'agent.activity.processing';
        runtime.writer?.({
          event: 'tool.status',
          data: { labelKey, phase: 'start' },
        });
        const started = performance.now();
        try {
          return JSON.stringify({ ok: true, data: await handler(input, runtime) });
        } catch (error: unknown) {
          if (isGraphBubbleUp(error)) throw error;
          if (error instanceof Error && error.message === 'RUN_ABORTED') throw error;
          const code =
            error instanceof Error && safeErrors.includes(error.message)
              ? error.message
              : 'TOOL_UNAVAILABLE';
          const issue = issueCards[code];
          if (issue)
            runtime.writer?.({
              event: 'card',
              data: {
                cardId: uuidV7(),
                type: issue.type,
                payload: { title: issue.title, description: issue.description },
              },
            });
          return JSON.stringify({
            ok: false,
            error: { code, retryable: code === 'TOOL_UNAVAILABLE' },
          });
        } finally {
          this.totalToolMs += performance.now() - started;
          runtime.writer?.({
            event: 'tool.status',
            data: { labelKey, phase: 'end' },
          });
        }
      },
      { name, description, schema },
    );
  }
}
