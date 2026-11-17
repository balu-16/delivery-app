import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Json } from '../../../platform/database/database.js';
import type { OrderOperations } from '../../orders/contracts/orders.js';
import type { CheckoutOperations } from '../../checkout/contracts/checkout.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import { AgentDrafts, STALE_DRAFT } from './drafts.js';
import { AgentOrderPlacement, orderDraft } from './placement.js';
import { sanitizeAgentText } from './guards.js';
import type { AgentToolKit } from './tool-kit.js';

interface Context {
  userId: string;
  threadId: string;
  confirmTtlSeconds: number;
  maxOrderPaise: string;
}
interface Dependencies {
  orders: OrderOperations;
  checkout: CheckoutOperations;
  cart: CartService;
  addresses: AddressOperations;
}
const cancelPayload = z
  .object({
    orderId: z.string().uuid(),
    orderNumber: z.string(),
    status: z.string(),
    version: z.string(),
    reason: z.string(),
  })
  .strict();

/** The interrupt carries a server-stored draft. Execution uses only that draft. */
export function createConfirmTools(
  deps: Dependencies,
  drafts: AgentDrafts,
  placement: AgentOrderPlacement,
  context: Context,
  kit: AgentToolKit,
) {
  const { orders } = deps;
  return [
    kit.define(
      'cancel_order',
      'Prepare a cancellation only after the customer requests it. A confirmation card must be approved before cancellation.',
      z.object({
        orderId: z.string().uuid().describe('Customer-owned order id'),
        reason: z.string().min(1).max(200).describe('Reason given by the customer'),
      }),
      async (input, runtime) => {
        let draft = await drafts.byCall(context.userId, context.threadId, runtime.toolCallId);
        if (!draft) {
          const order = await orders.byId(input.orderId, { userId: context.userId });
          if (!order) throw new Error('ORDER_NOT_FOUND');
          const payload = {
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            status: order.status,
            version: order.version,
            reason: sanitizeAgentText(input.reason, 200),
          };
          if (!payload.reason) throw new Error('INVALID_INPUT');
          draft = await drafts.prepare({
            userId: context.userId,
            threadId: context.threadId,
            toolCallId: runtime.toolCallId,
            type: 'cancel',
            payload,
            expiresAt: new Date(Date.now() + context.confirmTtlSeconds * 1000),
          });
        }
        const payload = cancelPayload.parse(draft.payload);
        const expiresAt = draft.expires_at.toISOString();
        runtime.writer?.({
          event: 'card',
          data: {
            cardId: draft.id,
            type: 'cancel_confirm',
            payload: {
              draftId: draft.id,
              expiresAt,
              status: draft.status,
              title: `Cancel order ${payload.orderNumber}?`,
              description:
                'Cancellation depends on the current order status. Any refund follows the existing order rules.',
            },
          },
        });
        runtime.writer?.({
          event: 'draft.required',
          data: { draftId: draft.id, type: 'cancel', expiresAt },
        });
        const response: unknown = interrupt({ draftId: draft.id, type: 'cancel', expiresAt });
        const decision = z
          .object({ draftId: z.string().uuid(), decision: z.enum(['approve', 'reject']) })
          .strict()
          .parse(response);
        if (decision.draftId !== draft.id) throw new Error('DRAFT_INVALID');
        return drafts.decide(
          {
            userId: context.userId,
            threadId: context.threadId,
            draftId: draft.id,
            decision: decision.decision,
          },
          async (stored, tx) => {
            const approved = cancelPayload.parse(stored);
            const locked = await sql<{
              version: string;
            }>`SELECT version::text FROM orders WHERE id=${approved.orderId}::uuid AND user_id=${context.userId}::uuid FOR UPDATE`.execute(
              tx,
            );
            if (!locked.rows[0] || locked.rows[0].version !== approved.version) return STALE_DRAFT;
            const cancelled = await orders.cancel(
              approved.orderId,
              { type: 'CUSTOMER', id: context.userId },
              approved.reason,
              { tx },
            );
            return {
              orderId: cancelled.orderId,
              orderNumber: cancelled.orderNumber,
              status: cancelled.status,
              paymentStatus: cancelled.paymentStatus,
            } as Json;
          },
        );
      },
    ),
    kit.define(
      'place_order',
      'Prepare an order from the current cart only when the customer asks to order. The customer must approve the displayed totals before it is placed. Only eligible cash on delivery or an existing wallet balance can be used.',
      z.object({}),
      async (_input, runtime) => {
        let draft = await drafts.byCall(context.userId, context.threadId, runtime.toolCallId);
        if (!draft) {
          const cart = await deps.cart.get(context.userId);
          if (!cart || !cart.lines.length) throw new Error('CART_NOT_FOUND');
          const address = (await deps.addresses.list(context.userId)).find(
            (item) => item.id === cart.addressId,
          );
          if (!address) throw new Error('ADDRESS_NOT_FOUND');
          const quoted = await deps.checkout.quote(context.userId, {
            addressId: cart.addressId,
            ...(cart.couponCode ? { couponCode: cart.couponCode } : {}),
          });
          if (quoted.quote.issues.some((issue) => issue.code !== 'PRICE_CHANGED'))
            throw new Error('CART_NOT_READY');
          if (BigInt(quoted.quote.totalPaise) > BigInt(context.maxOrderPaise))
            throw new Error('AGENT_ORDER_LIMIT');
          if (BigInt(quoted.quote.amountDuePaise) > 0n && !quoted.codAvailable)
            throw new Error('COD_NOT_ELIGIBLE');
          const items = quoted.quote.lines.map((line) => {
            const original = cart.lines.find((item) => item.variantId === line.variantId);
            if (!original) throw new Error('CONCURRENT_MODIFICATION');
            return {
              variantId: line.variantId,
              name: sanitizeAgentText(original.productName, 160),
              variantName: sanitizeAgentText(original.variantName, 100),
              quantity: line.quantity,
              unitPricePaise: line.unitPricePaise,
            };
          });
          const payload = orderDraft.parse({
            quoteId: quoted.quote.quoteId,
            intentId: quoted.intentId,
            addressId: address.id,
            method: 'COD',
            totalPaise: quoted.quote.totalPaise,
            amountDuePaise: quoted.quote.amountDuePaise,
            formattedAddress: [address.line1, address.line2, address.pincode]
              .filter((value): value is string => Boolean(value))
              .map((value) => sanitizeAgentText(value, 200))
              .join(', '),
            items,
            fees: quoted.quote.fees,
            discountPaise: quoted.quote.discountPaise,
            taxTotalPaise: quoted.quote.taxTotalPaise,
            walletCashPaise: quoted.quote.wallet?.cashPaise ?? '0',
            walletPromoPaise: quoted.quote.wallet?.promoPaise ?? '0',
          });
          const expiry = Math.min(
            Date.now() + context.confirmTtlSeconds * 1000,
            Date.parse(quoted.intentExpiresAt),
          );
          if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('QUOTE_EXPIRED');
          draft = await drafts.prepare({
            userId: context.userId,
            threadId: context.threadId,
            toolCallId: runtime.toolCallId,
            type: 'order',
            payload,
            expiresAt: new Date(expiry),
          });
        }
        const payload = orderDraft.parse(draft.payload),
          expiresAt = draft.expires_at.toISOString();
        runtime.writer?.({
          event: 'card',
          data: {
            cardId: draft.id,
            type: 'order_confirm',
            payload: {
              ...payload,
              quoteId: undefined,
              intentId: undefined,
              draftId: draft.id,
              expiresAt,
              status: draft.status,
              title: 'Confirm your order',
              formatted: payload.formattedAddress,
              description: 'Payment: cash on delivery or existing wallet balance.',
            },
          },
        });
        runtime.writer?.({
          event: 'draft.required',
          data: { draftId: draft.id, type: 'order', expiresAt },
        });
        const response: unknown = interrupt({ draftId: draft.id, type: 'order', expiresAt });
        const decision = z
          .object({ draftId: z.string().uuid(), decision: z.enum(['approve', 'reject']) })
          .strict()
          .parse(response);
        if (decision.draftId !== draft.id) throw new Error('DRAFT_INVALID');
        const staged = await drafts.stageDecision({
          userId: context.userId,
          threadId: context.threadId,
          draftId: draft.id,
          decision: decision.decision,
        });
        if (staged.status !== 'approved') return { status: staged.status, result: staged.result };
        return {
          status: 'executed',
          result: await placement.execute({
            userId: context.userId,
            threadId: context.threadId,
            draftId: draft.id,
            payload: staged.payload,
          }),
        };
      },
    ),
  ];
}
