import { z } from 'zod';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { OrderOperations, OrderView } from '../../orders/contracts/orders.js';
import type { WalletViews } from '../../wallet/contracts/wallet.js';
import type { AgentCard, AgentLocale } from '../contracts/agent.js';
import { sanitizeAgentText } from './guards.js';
import type { AgentToolKit } from './tool-kit.js';

interface AgentReadDependencies {
  addresses: AddressOperations;
  cart: CartService;
  catalog: CatalogQuery;
  orders: OrderOperations;
  wallet: WalletViews;
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
          : (addresses.find((address) => address.id === cart?.addressId) ??
            addresses.find((address) => address.isDefault));
        if (!chosen) {
          if (!input.addressId) {
            const label =
              context.locale === 'hi'
                ? 'पता जोड़ें'
                : context.locale === 'te'
                  ? 'చిరునామా జోడించండి'
                  : 'Add address';
            card(runtime.writer, 'info', {
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
        return { addressId: chosen.id, items };
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
