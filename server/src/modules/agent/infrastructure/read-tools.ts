import { z } from 'zod';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { OrderOperations, OrderView } from '../../orders/contracts/orders.js';
import type { WalletViews } from '../../wallet/contracts/wallet.js';
import type { CustomerTracking } from '../../dispatch/contracts/tasks.js';
import type { Serviceability } from '../../serviceability/contracts/serviceability.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CouponValidation } from '../../coupons/contracts/coupons.js';
import type { AgentCard, AgentLocale } from '../contracts/agent.js';
import { isPolicyTopic, policyText } from './policy.js';
import { sanitizeAgentText } from './guards.js';
import type { AgentToolKit } from './tool-kit.js';

interface AgentReadDependencies {
  addresses: AddressOperations;
  cart: CartService;
  catalog: CatalogQuery;
  orders: OrderOperations;
  wallet: WalletViews;
  tracking: CustomerTracking;
  serviceability: Serviceability;
  appConfig: AppConfig;
  coupons?: CouponValidation;
}
type Writer = ((chunk: unknown) => void) | null;
const text = (value: unknown, length = 160) =>
  typeof value === 'string' ? sanitizeAgentText(value, length) : '';
function card(writer: Writer, type: AgentCard['type'], payload: Record<string, unknown>): void {
  writer?.({ event: 'card', data: { cardId: uuidV7(), type, payload } });
}
function safeOrder(order: OrderView) {
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    totalPaise: order.totalPaise,
    placedAt: order.placedAt,
    items: order.items.map((item) => ({
      variantId: item.variantId,
      name: text(item.name),
      quantity: item.orderedQty,
    })),
  };
}
const PINCODE = /(?<![0-9])([1-9]\d{5})(?![0-9])/;
const PHONE = /(?<!\d)(?:\+?91[\s()-]*)?(?:\d[\s()-]*){10}(?![\s()-]*\d)/;
const LANDMARK = /\b(?:near|landmark|opp(?:osite)?|behind|beside)\b[:\s]*([^,;\n]+)/i;
const CONTACT_NAME =
  /\b(?:contact\s+)?name\s*(?:is|:|=)\s*([a-z][a-z .'-]{0,80}?)(?=\s*[,;\n]|\s+\b(?:phone|mobile|pin(?:code)?)\b|$)/i;
const firstStreet = (value: string) =>
  value
    .toLowerCase()
    .split(/[,\n;]+/)[0]
    ?.trim() ?? '';

/** Structural parse of a typed Indian address; coordinates are never inferred. */
export function parseAddressText(
  raw: string,
  saved: Awaited<ReturnType<AddressOperations['list']>>,
) {
  const body = sanitizeAgentText(raw, 600);
  const pincode = PINCODE.exec(body)?.[1];
  const phoneMatch = PHONE.exec(body)?.[0];
  const phoneDigits = phoneMatch?.replace(/\D/g, '');
  const localPhone =
    phoneDigits?.length === 12 && phoneDigits.startsWith('91') ? phoneDigits.slice(2) : phoneDigits;
  const contactPhone =
    localPhone && /^[6-9]\d{9}$/.test(localPhone) ? `+91${localPhone}` : undefined;
  const landmark = LANDMARK.exec(body)?.[1]?.trim();
  const contactName = CONTACT_NAME.exec(body)?.[1]?.trim();
  let remainder = body;
  if (pincode) remainder = remainder.replace(PINCODE, ' ');
  if (phoneMatch) remainder = remainder.replace(PHONE, ' ');
  if (landmark) remainder = remainder.replace(LANDMARK, ' ');
  if (contactName) remainder = remainder.replace(CONTACT_NAME, ' ');
  remainder = remainder
    .replace(
      /^\s*(?:please\s+|you\s+)?(?:add|save|create|store)\s+(?:the\s+|my\s+|an?\s+)?address\s*/i,
      '',
    )
    .replace(
      /\b(?:pin\s*code|pincode|phone(?:\s+number)?|mobile(?:\s+number)?)\s*(?:is|:|=)?/gi,
      ' ',
    );
  const lines = remainder
    .split(/[,\n;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 3);
  const line1 = lines[0] ?? '';
  const line2 = lines.slice(1).join(', ') || undefined;
  const missingFields = [
    ...(pincode ? [] : ['pincode']),
    ...(line1 ? [] : ['street address']),
    ...(contactPhone ? [] : ['contact phone']),
    ...(contactName ? [] : ['contact name']),
  ];
  const duplicateOf = saved.find(
    (address) =>
      pincode !== undefined &&
      address.pincode === pincode &&
      firstStreet(line1).length > 3 &&
      firstStreet(address.line1 ?? '') === firstStreet(line1),
  );
  return {
    line1,
    line2,
    landmark,
    pincode,
    contactPhone,
    contactName,
    phoneInput: localPhone,
    missingFields,
    invalidFields: phoneMatch && !contactPhone ? ['contact phone'] : [],
    duplicateOfAddressId: duplicateOf?.id,
    duplicateLabel: duplicateOf?.label,
  };
}
/** The caller supplies the identity; no tool accepts or infers a user id. */
export function createReadTools(
  deps: AgentReadDependencies,
  context: { userId: string; locale: AgentLocale },
  kit: AgentToolKit,
) {
  return [
    kit.define(
      'list_addresses',
      'List the customer’s saved addresses. Use to choose a delivery address; never infer an address.',
      z.object({}),
      async () => {
        const addresses = await deps.addresses.list(context.userId);
        return addresses.map((address) => ({
          id: address.id,
          label: address.label ?? 'OTHER',
          formatted: [address.line1, address.line2, address.pincode]
            .filter(Boolean)
            .map((part) => text(part))
            .join(', '),
          isDefault: address.isDefault,
          locationConfirmed: address.point !== null,
        }));
      },
    ),
    kit.define(
      'search_products',
      'Search the catalog available at a saved delivery address. Ask for an address if none exists.',
      z.object({
        query: z.string().min(1).max(100).describe('Product name or search phrase'),
        addressId: z.string().uuid().optional().describe('Optional id of a saved delivery address'),
      }),
      async (input, runtime) => {
        const addresses = await deps.addresses.list(context.userId);
        const cart = await deps.cart.get(context.userId);
        const chosen = input.addressId
          ? addresses.find((address) => address.id === input.addressId)
          : (addresses.find((address) => address.isDefault) ??
            addresses.find((address) => address.id === cart?.addressId));
        if (!chosen) {
          if (!input.addressId) {
            const label =
              context.locale === 'hi'
                ? 'पता जोड़ें'
                : context.locale === 'te'
                  ? 'చిరునామా జోడించండి'
                  : 'Add address';
            if (kit.showCardOnce('delivery-address-required'))
              card(runtime.writer, 'info', {
                title: 'Add a delivery address',
                description: 'Add an address so we can check which products are available.',
                options: [{ label, action: 'open_screen', payload: { screen: 'addresses' } }],
              });
          }
          throw new Error(input.addressId ? 'ADDRESS_NOT_FOUND' : 'ADDRESS_REQUIRED');
        }
        const result = await deps.catalog.list(context.userId, chosen.id, {
          q: sanitizeAgentText(input.query, 100),
          limit: 8,
        });
        const items = result.items.slice(0, 8).map((value) => {
          const item = value as Record<string, unknown>;
          return {
            productId: text(item.productId, 40),
            variantId: text(item.variantId, 40),
            name: text(item.name),
            variantName: text(item.variantName),
            sellingPaise: text(item.sellingPaise, 20),
            availability: text(item.availability, 40),
            maxPerOrder: typeof item.maxPerOrder === 'number' ? item.maxPerOrder : 0,
          };
        });
        const addLabel =
          context.locale === 'hi' ? 'जोड़ें' : context.locale === 'te' ? 'జోడించు' : 'Add';
        const options = items
          .filter(
            (item) =>
              item.variantId && item.availability !== 'OUT_OF_STOCK' && item.maxPerOrder > 0,
          )
          .map((item) => ({
            label: `${addLabel} ${item.name}`,
            action: 'add_to_cart',
            payload: { variantId: item.variantId, quantity: 1, addressId: chosen.id },
          }));
        card(runtime.writer, 'product_list', { title: 'Products', items, options });
        if (items.some((item) => item.availability === 'OUT_OF_STOCK')) {
          card(runtime.writer, 'out_of_stock', {
            title: 'Some items are unavailable',
            description: 'Choose an available item or browse the farm for something else.',
            items: items
              .filter((item) => item.availability === 'OUT_OF_STOCK')
              .map((item) => ({ name: item.name, variantName: item.variantName })),
          });
        }
        return { addressId: chosen.id, items };
      },
    ),
    kit.define(
      'list_available_coupons',
      'List the current customer’s available offer codes for the cart. Actual eligibility and savings are checked in the cart; never apply an offer without the customer choosing it.',
      z.object({}),
      async (_input, runtime) => {
        if (!deps.coupons) throw new Error('TOOL_UNAVAILABLE');
        const scope = await deps.cart.freshSubtotal(context.userId);
        if (!scope) throw new Error('CART_NOT_FOUND');
        const offers = await deps.coupons.available(
          context.userId,
          scope.storeId,
          scope.subtotalPaise,
        );
        const items = offers
          .slice(0, 8)
          .map((offer) => ({
            name: offer.code,
            kind: offer.kind,
            valuePaise: offer.valuePaise,
            minOrderPaise: offer.minOrderPaise,
          }));
        card(runtime.writer, 'info', {
          title: 'Available offers',
          description: items.length
            ? 'Choose an offer in your cart. Eligibility and savings are checked there.'
            : 'There are no offers available for this cart right now.',
          items,
          options: [
            { label: 'View cart offers', action: 'open_screen', payload: { screen: 'cart' } },
          ],
        });
        return { items };
      },
    ),
    kit.define(
      'get_cart',
      'Read the current cart and its available items. Do not modify it.',
      z.object({}),
      async () => {
        const cart = await deps.cart.get(context.userId);
        if (!cart) return { items: [] };
        return {
          addressId: cart.addressId,
          version: cart.version,
          couponCode: cart.couponCode,
          items: cart.lines.map((line) => ({
            variantId: line.variantId,
            name: text(line.productName),
            variantName: text(line.variantName),
            quantity: line.quantity,
            unitPricePaise: line.unitPricePaise,
          })),
          issues: cart.issues.map((issue) => ({ code: issue.code })),
        };
      },
    ),
    kit.define(
      'get_order_history_summary',
      'Read what this signed-in customer has had delivered. Returns up to eight variants ranked by how often they were bought, then by recency, with the quantity from the newest delivered order. Use for "my usual". Offer the candidates and let the customer keep or change them. Do not place an order from this result. After they choose, search the catalog, set quantities, check the address and serviceability, then call place_order. place_order rechecks the current stock and price; there is no separate quote tool.',
      z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe('How many recent delivered orders to read, from 1 to 20'),
      }),
      async (input, runtime) => {
        const items = (await deps.orders.purchaseSummary(context.userId, input.limit)).map(
          (item) => ({ ...item, name: text(item.name, 120) }),
        );
        if (items.length) {
          const [addresses, cart, maxQuantity] = await Promise.all([
            deps.addresses.list(context.userId),
            deps.cart.get(context.userId),
            deps.appConfig.get('agent_max_qty_per_line'),
          ]);
          const chosen =
            addresses.find((address) => address.isDefault) ??
            addresses.find((address) => address.id === cart?.addressId);
          card(runtime.writer, 'product_list', {
            title: 'Your usual items',
            items: items.map((item) => ({
              variantId: item.variantId,
              name: item.name,
              quantity: String(item.lastQuantity),
              maxPerOrder: maxQuantity,
            })),
            options: chosen
              ? items.map((item) => ({
                  label: `Add ${item.name}`,
                  action: 'add_to_cart',
                  payload: { variantId: item.variantId, quantity: 1, addressId: chosen.id },
                }))
              : [
                  {
                    label: 'Choose delivery address',
                    action: 'open_screen',
                    payload: { screen: 'addresses' },
                  },
                ],
          });
        }
        return { items };
      },
    ),
    kit.define(
      'list_recent_orders',
      'List recent orders owned by this customer, for order questions and reordering.',
      z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(5)
          .describe('Maximum number of recent orders'),
      }),
      async (input, runtime) => {
        const page = await deps.orders.list(context.userId, input.limit);
        const items = page.items.map(safeOrder);
        if (items.length) card(runtime.writer, 'order_status', { title: 'Recent orders', items });
        return { items };
      },
    ),
    kit.define(
      'get_order_details',
      'Get a customer-owned order by id; use only an id from a previous order list.',
      z.object({
        orderId: z.string().uuid().describe('An order id previously returned by a tool'),
      }),
      async (input, runtime) => {
        const order = await deps.orders.byId(input.orderId, { userId: context.userId });
        if (!order) throw new Error('ORDER_NOT_FOUND');
        const result = safeOrder(order);
        card(runtime.writer, 'order_status', { title: `Order ${result.orderNumber}`, ...result });
        return result;
      },
    ),
    kit.define(
      'get_order_tracking',
      'Get the live delivery status and arrival estimate for a customer-owned order.',
      z.object({
        orderId: z.string().uuid().describe('An order id previously returned by a tool'),
      }),
      async (input) => {
        const tracking = await deps.tracking.tracking(input.orderId, context.userId);
        if (tracking)
          return {
            orderId: tracking.orderId,
            taskStatus: tracking.taskStatus,
            attemptNo: tracking.attemptNo,
            eta: tracking.eta
              ? { minMinutes: tracking.eta.minMinutes, maxMinutes: tracking.eta.maxMinutes }
              : null,
          };
        const order = await deps.orders.byId(input.orderId, { userId: context.userId });
        if (!order) throw new Error('ORDER_NOT_FOUND');
        return { orderId: order.orderId, status: order.status, taskStatus: null, eta: null };
      },
    ),
    kit.define(
      'check_serviceability',
      'Check whether a saved address can currently be served, with the delivery estimate range. Use when a customer asks about delivery to an address or an order fails.',
      z.object({ addressId: z.string().uuid().describe('A saved address id from list_addresses') }),
      async (input, runtime) => {
        const address = (await deps.addresses.list(context.userId)).find(
          (item) => item.id === input.addressId,
        );
        if (!address) throw new Error('ADDRESS_NOT_FOUND');
        const result = await deps.serviceability.check({
          pincode: address.pincode,
          targetTime: new Date(),
        });
        if (!result.serviceable) {
          const descriptions: Partial<Record<(typeof result.reasons)[number], string>> = {
            OUTSIDE_ZONE: 'This address is outside the current delivery area.',
            STORE_CLOSED: 'The store serving this address is currently closed.',
            STORE_PAUSED: 'The store serving this address is not accepting orders right now.',
            STORE_AT_CAPACITY: 'The store is currently at delivery capacity.',
            NO_RIDERS_AVAILABLE: 'No delivery partners are currently available.',
          };
          card(runtime.writer, 'delivery_unavailable', {
            title: 'Delivery is unavailable here',
            description:
              result.reasons
                .map((reason) => descriptions[reason])
                .filter(Boolean)
                .join(' ') || 'Please try another address or check back later.',
          });
        }
        return {
          serviceable: result.serviceable,
          storeId: result.storeId,
          eta: result.etaRange,
          reasons: result.reasons,
        };
      },
    ),
    kit.define(
      'parse_and_validate_address',
      'Parse typed Indian address details and identify missing fields. If the customer explicitly requested saving and provided every required field in their current message, call save_address. Otherwise ask for missing details or offer the address screen. Never infer coordinates.',
      z.object({
        text: z.string().min(5).max(600).describe('The address exactly as the customer typed it'),
      }),
      async (input, runtime) => {
        const saved = await deps.addresses.list(context.userId);
        const parsed = parseAddressText(input.text, saved);
        if (parsed.duplicateOfAddressId) {
          const label =
            context.locale === 'hi'
              ? 'यह पता पहले से सहेजा गया है'
              : context.locale === 'te'
                ? 'ఈ చిరునామా ఇప్పటికే సేవ్ చేయబడింది'
                : 'This address is already saved';
          if (kit.showCardOnce('delivery-address-required'))
            card(runtime.writer, 'info', {
              title: label,
              options: [
                {
                  label:
                    context.locale === 'hi'
                      ? 'पते देखें'
                      : context.locale === 'te'
                        ? 'చిరునామాలు చూడండి'
                        : 'View addresses',
                  action: 'open_screen',
                  payload: {
                    screen: 'addresses',
                    addressId: parsed.duplicateOfAddressId,
                    line1: parsed.line1 || undefined,
                    line2: parsed.line2,
                    pincode: parsed.pincode,
                    phone: parsed.phoneInput,
                  },
                },
              ],
            });
          return {
            duplicateOfAddressId: parsed.duplicateOfAddressId,
            label: parsed.duplicateLabel ?? 'OTHER',
          };
        }
        const addLabel =
          context.locale === 'hi'
            ? 'पता जोड़ें'
            : context.locale === 'te'
              ? 'చిరునామా జోడించండి'
              : 'Add address';
        if (parsed.missingFields.length && kit.showCardOnce('delivery-address-required'))
          card(runtime.writer, 'info', {
            title: 'Add address',
            line1: parsed.line1 || undefined,
            line2: parsed.line2,
            landmark: parsed.landmark,
            pincode: parsed.pincode,
            contactPhone: parsed.contactPhone,
            missingFields: parsed.missingFields,
            description: parsed.missingFields.length
              ? `Still needed: ${parsed.missingFields.join(', ')}.`
              : undefined,
            options: [
              {
                label: addLabel,
                action: 'open_screen',
                payload: {
                  screen: 'addresses',
                  line1: parsed.line1 || undefined,
                  line2: parsed.line2,
                  pincode: parsed.pincode,
                  phone: parsed.phoneInput,
                  contact: parsed.contactName,
                  focus: parsed.missingFields.includes('contact phone')
                    ? 'phone'
                    : parsed.missingFields.includes('pincode')
                      ? 'pincode'
                      : parsed.missingFields.includes('street address')
                        ? 'line1'
                        : undefined,
                },
              },
            ],
          });
        return {
          ...parsed,
          nextStep: parsed.missingFields.length
            ? 'Ask for the missing details or offer the address screen.'
            : 'If the customer explicitly requested saving, call save_address with the supplied fields.',
        };
      },
    ),
    kit.define(
      'get_policy_text',
      'Answer questions about delivery fees, refunds, cancellation, timings, wallet, subscriptions or contacting support from the configured policy.',
      z.object({
        topic: z
          .enum([
            'delivery_fees',
            'refunds',
            'cancellation',
            'timings',
            'wallet',
            'subscriptions',
            'contact',
          ])
          .describe('The policy topic the customer asked about'),
      }),
      async (input) => {
        if (!isPolicyTopic(input.topic)) throw new Error('INVALID_INPUT');
        return { topic: input.topic, text: await policyText(input.topic, deps.appConfig) };
      },
    ),
    kit.define(
      'get_wallet_summary',
      'Read the customer’s wallet balance. Never offer to add or withdraw money.',
      z.object({}),
      async () => {
        const balance = await deps.wallet.balances(context.userId);
        return { cashPaise: balance.cashPaise, promoPaise: balance.promoPaise };
      },
    ),
  ];
}
