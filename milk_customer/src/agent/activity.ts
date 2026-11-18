import type { AgentDictionary } from './strings';

type ActivityKey = keyof AgentDictionary;
const toolActivities: Readonly<Record<string, ActivityKey>> = {
  list_addresses: 'activityAddresses',
  search_products: 'activityProducts',
  get_cart: 'activityCart',
  get_order_history_summary: 'activityHistory',
  list_recent_orders: 'activityOrders',
  get_order_details: 'activityOrders',
  get_order_tracking: 'activityTracking',
  check_serviceability: 'activityService',
  parse_and_validate_address: 'activityAddresses',
  get_policy_text: 'activityPolicy',
  get_wallet_summary: 'activityWallet',
  list_available_coupons: 'activityOffers',
  set_cart_item_qty: 'activityCartUpdate',
  clear_cart: 'activityCartClear',
  select_address_for_order: 'activityAddresses',
  report_order_issue: 'activitySupport',
  escalate_to_human: 'activitySupport',
  set_reorder_nudges: 'activityNudges',
  place_order: 'activityOrder',
  cancel_order: 'activityCancel',
  request_refund: 'activityRefund',
};
const activityAliases: Readonly<Record<string, string>> = {
  savedAddresses: 'list_addresses', findProducts: 'search_products', viewCart: 'get_cart',
  usualItems: 'get_order_history_summary', recentOrders: 'list_recent_orders', orderDetails: 'get_order_details',
  deliveryTracking: 'get_order_tracking', deliveryAvailability: 'check_serviceability', addressDetails: 'parse_and_validate_address',
  policy: 'get_policy_text', wallet: 'get_wallet_summary', updateCart: 'set_cart_item_qty', emptyCart: 'clear_cart',
  offers: 'list_available_coupons',
  selectAddress: 'select_address_for_order', orderIssue: 'report_order_issue', contactSupport: 'escalate_to_human',
  reminders: 'set_reorder_nudges', orderPreparation: 'place_order', cancellation: 'cancel_order', refundRequest: 'request_refund',
};

/** Labels describe in-flight work only: an end event is not proof of success. */
export function toolActivity(labelKey: string, text: AgentDictionary, decision?: 'approve' | 'reject'): string {
  const name = labelKey.startsWith('agent.activity.') ? activityAliases[labelKey.slice('agent.activity.'.length)]
    : labelKey.startsWith('agent.tool.') ? labelKey.slice('agent.tool.'.length) : undefined;
  if (!name) return text.activityPreparing;
  if (decision === 'reject' && ['place_order', 'cancel_order', 'request_refund'].includes(name)) return text.activityDecision;
  if (decision === 'approve' && name === 'place_order') return text.activityPlacing;
  if (decision === 'approve' && name === 'cancel_order') return text.activityCancelling;
  return text[toolActivities[name] ?? 'activityPreparing'];
}

/** Tracks concurrent calls, including repeated calls with the same label. */
export function updateActiveTools(active: string[], labelKey: string, phase: unknown): string[] {
  if (phase === 'start') return [...active, labelKey];
  if (phase !== 'end') return active;
  const index = active.lastIndexOf(labelKey);
  return index < 0 ? active : [...active.slice(0, index), ...active.slice(index + 1)];
}
