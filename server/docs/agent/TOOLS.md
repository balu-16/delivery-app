# Assistant tools

Every tool wraps an existing domain use-case; none accepts or infers a customer id — the run
supplies the identity. Error codes reach the model verbatim (whitelisted in `tool-kit.ts`);
anything else surfaces as `TOOL_UNAVAILABLE`. All writes are transactional, replay-safe by the
model's tool-call id (`agent_tool_operations`), permission-checked (`requireAgentPermission`)
and audited with `source: 'AGENT'`.

## Reads (T0)

| Tool | Args | Backing use-case | Notes |
| --- | --- | --- | --- |
| `list_addresses` | – | `ADDRESSES.list` | label, formatted line, default flag |
| `search_products` | `query`, `addressId?` | `ADDRESSES.list` + `CART_SERVICE.get` + `CATALOG_QUERY.list` | store-scoped by cart/default address; emits `product_list` card with `add_to_cart` options; `ADDRESS_REQUIRED` when the customer has no address (emits add-address `info` card) |
| `get_cart` | – | `CART_SERVICE.get` | lines, version, coupon, issues |
| `get_order_history_summary` | `limit<=20` | `ORDERS.list` | server-computed usual items: order count, last quantity, recency |
| `list_recent_orders` | `limit<=8` | `ORDERS.list` | emits `order_status` card |
| `get_order_details` | `orderId` | `ORDERS.byId({userId})` | owner-checked; emits `order_status` card |
| `get_order_tracking` | `orderId` | `CUSTOMER_TRACKING.tracking` (dispatch) | task status, attempt, ETA range; rider contact is not exposed to customers |
| `check_serviceability` | `addressId` | `ADDRESSES.list` + `SERVICEABILITY.check` | coordinates come from the owned address only |
| `parse_and_validate_address` | `text<=600` | pure parser + `ADDRESSES.list` (duplicate check) | extracts street/landmark/pincode/phone (+91 normalised); reports `missingFields`; never invents coordinates; emits add-address `info` card; duplicates return the existing address id |
| `get_policy_text` | `topic` enum | app-config composed `policy.ts` | fees/timings/refunds rendered from configured values; subscriptions/wallet answer honestly |
| `get_wallet_summary` | – | `WALLET_VIEWS.balances` | cash + promo only |

## Writes (T1)

| Tool | Args | Backing use-case | Notes |
| --- | --- | --- | --- |
| `set_cart_item_qty` | `variantId`, `quantity 0..max`, `addressId?` | `CART_SERVICE.putItem` (absolute) | audited `AGENT_CART_CHANGED` |
| `clear_cart` | – | `CART_SERVICE.deleteCart` | audited `AGENT_CART_CLEARED`; no-op on empty cart |
| `select_address_for_order` | `addressId` | `CART_SERVICE.getOrCreateActiveCart` | rebinds store, returns re-evaluated issues; audited `AGENT_CART_ADDRESS` |
| `report_order_issue` | `category` enum, `orderId?`, `description<=1000` | `SUPPORT.create` (reference `agent:{thread}:{callId}`) | ticket id only |
| `escalate_to_human` | `orderId?`, `summary<=1000` | `SUPPORT.create` (`escalation`) | sanitised summary |
| `set_reorder_nudges` | `enabled` | `agent_nudge_preferences` upsert | audited `AGENT_NUDGE_PREFERENCE` |

## Confirmations (T2 — draft → card → `interrupt()` → execute stored payload)

| Tool | Draft | Execute | Notes |
| --- | --- | --- | --- |
| `place_order` | `order` (quote from `CHECKOUT.quote`, `agent_max_order_value_paise` cap, COD eligibility, intent expiry) | checkout placement via `IdempotencyStore.claim` + `CheckoutPlacementGuard` | `order_confirm` card; stale quote → `STALE_DRAFT` |
| `cancel_order` | `cancel` (order version pinned) | `ORDERS.cancel` under `FOR UPDATE` version re-check | `cancel_confirm` card |
| `request_refund` | `refund_request` | `SUPPORT.create` (`refund_request`) with the draft re-verified inside the ticket transaction | `refund_confirm` card; wording is "request", never "refund approved" |

Not exposed (T3): payments, wallet top-up, login changes, account deletion, admin actions,
subscriptions (feature-disabled by product decision), coupons/substitutes/recipes (no
customer-safe contracts in those domains yet — see ADR 0003).
