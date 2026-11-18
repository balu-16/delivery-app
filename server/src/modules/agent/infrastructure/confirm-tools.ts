import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Json } from '../../../platform/database/database.js';
import type { OrderOperations } from '../../orders/contracts/orders.js';
import type { CheckoutOperations } from '../../checkout/contracts/checkout.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { Support } from '../../support/contracts/support.js';
import type { Serviceability } from '../../serviceability/contracts/serviceability.js';
import { AgentDrafts, STALE_DRAFT } from './drafts.js';
import { AgentOrderPlacement, orderDraft } from './placement.js';
import { draftHash, sanitizeAgentText } from './guards.js';
import { assertAgentCommitAllowed, requireAgentPermission } from './security.js';
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
  support: Support;
  serviceability?: Serviceability;
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
const refundPayload = z
  .object({ orderId: z.string().uuid(), orderNumber: z.string(), reason: z.string() })
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
      'Prepare an order from the current cart when the customer asks to order or agrees to the items already in the cart. Call it in that same turn; a written summary does not create the confirmation card. The customer approves the card before anything is placed. Only eligible cash on delivery or an existing wallet balance can be used.',
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
          const [quoted, delivery] = await Promise.all([
            deps.checkout
              .quote(context.userId, {
                addressId: cart.addressId,
                ...(cart.couponCode ? { couponCode: cart.couponCode } : {}),
              })
              .catch((error: unknown) => {
                if (
                  error instanceof Error &&
                  error.message === 'ADDRESS_LOCATION_REQUIRED' &&
                  kit.showCardOnce('delivery-address-required')
                )
                  runtime.writer?.({
                    event: 'card',
                    data: {
                      cardId: uuidV7(),
                      type: 'info',
                      payload: {
                        title: 'Confirm delivery location',
                        description:
                          'When you are at the delivery address, share your location to place this order.',
                        options: [
                          {
                            label: 'Confirm location',
                            action: 'open_screen',
                            payload: {
                              screen: 'addresses',
                              addressId: address.id,
                              needsLocation: true,
                            },
                          },
                        ],
                      },
                    },
                  });
                throw error;
              }),
            deps.serviceability?.check({ pincode: address.pincode, targetTime: new Date() }) ??
              Promise.resolve(null),
          ]);
          if (delivery && !delivery.serviceable) throw new Error('ADDRESS_NOT_SERVICEABLE');
          if (
            quoted.quote.issues.some(
              (issue) => issue.code === 'ITEM_UNAVAILABLE' || issue.code === 'QTY_REDUCED',
            )
          )
            throw new Error('INVENTORY_INSUFFICIENT');
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
            etaRange: delivery?.etaRange ?? null,
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
              description:
                'Eligible wallet balance is applied automatically. Any remaining amount is due on delivery.',
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
    kit.define(
      'request_refund',
      'Prepare a refund request for a customer-owned order when the customer asks for money back. Approval raises a support request; support decides the refund. Never promise the refund itself.',
      z.object({
        orderId: z.string().uuid().describe('Customer-owned order id'),
        reason: z.string().min(1).max(200).describe('Reason given by the customer'),
      }),
      async (input, runtime) => {
        let draft = await drafts.byCall(context.userId, context.threadId, runtime.toolCallId);
        if (!draft) {
          const order = await deps.orders.byId(input.orderId, { userId: context.userId });
          if (!order) throw new Error('ORDER_NOT_FOUND');
          const reason = sanitizeAgentText(input.reason, 200);
          if (!reason) throw new Error('INVALID_INPUT');
          draft = await drafts.prepare({
            userId: context.userId,
            threadId: context.threadId,
            toolCallId: runtime.toolCallId,
            type: 'refund_request',
            payload: { orderId: order.orderId, orderNumber: order.orderNumber, reason },
            expiresAt: new Date(Date.now() + context.confirmTtlSeconds * 1000),
          });
        }
        const payload = refundPayload.parse(draft.payload);
        const expiresAt = draft.expires_at.toISOString();
        runtime.writer?.({
          event: 'card',
          data: {
            cardId: draft.id,
            type: 'refund_confirm',
            payload: {
              draftId: draft.id,
              expiresAt,
              status: draft.status,
              title: `Request a refund for order ${payload.orderNumber}?`,
              description:
                'This raises a support request. Our support team reviews it and decides the refund.',
            },
          },
        });
        runtime.writer?.({
          event: 'draft.required',
          data: { draftId: draft.id, type: 'refund_request', expiresAt },
        });
        const response: unknown = interrupt({
          draftId: draft.id,
          type: 'refund_request',
          expiresAt,
        });
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
        // Outside the staging transaction; support_operations replays by reference and the
        // guard re-verifies the stored draft inside the ticket transaction.
        const ticketId = await deps.support.create(
          context.userId,
          {
            category: 'refund_request',
            orderId: payload.orderId,
            body: `Refund request for order ${payload.orderNumber}: ${payload.reason}`,
            reference: `agent:${context.threadId}:${draft.id}`.slice(0, 150),
          },
          {
            beforeCreate: async (tx) => {
              await requireAgentPermission(context.userId, tx);
              await assertAgentCommitAllowed(tx, context.userId, context.threadId);
              const rows = await sql<{
                status: string;
                payload: unknown;
                payload_hash: string;
                expires_at: Date;
              }>`SELECT status,payload,payload_hash,expires_at FROM agent_drafts WHERE id=${draft.id}::uuid AND user_id=${context.userId}::uuid AND thread_id=${context.threadId}::uuid FOR UPDATE`.execute(
                tx,
              );
              const row = rows.rows[0];
              if (
                !row ||
                !['approved', 'executed'].includes(row.status) ||
                draftHash(row.payload) !== row.payload_hash ||
                (row.status === 'approved' && row.expires_at.getTime() <= Date.now())
              )
                throw new Error('DRAFT_INVALID');
            },
          },
        );
        return {
          status: 'executed',
          result: await drafts.markExecuted({
            userId: context.userId,
            threadId: context.threadId,
            draftId: draft.id,
            result: { ticketId, ticketStatus: 'OPEN', request: true },
          }),
        };
      },
    ),
  ];
}
