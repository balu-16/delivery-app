import { z } from 'zod';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { Support } from '../../support/contracts/support.js';
import { assertQuantity, sanitizeAgentText } from './guards.js';
import type { AgentToolKit } from './tool-kit.js';
import { requireAgentPermission, assertAgentCommitAllowed, lockAgentThread } from './security.js';
import {
  assertWriteCandidate,
  requestedAddQuantity,
  stableOperationHash,
  type AgentCandidateStore,
} from './product-candidates.js';

interface Dependencies {
  db: Database;
  locationRequired?: () => Promise<boolean>;
  addresses: AddressOperations;
  cart: CartService;
  support: Support;
}
interface Context {
  userId: string;
  threadId: string;
  maxQuantity: number;
  userText?: string;
  clientMessageId?: string;
  candidates?: AgentCandidateStore;
}
interface CartWriteOptions {
  noteId?: string;
  displayedCardPrice?: string;
  /** A confirmed choice joins the caller's locked transaction. */
  tx?: TransactionContext;
}

/** Absolute quantity writes are audited and replayed by the model's tool-call id. */
async function writeAgentCart(
  deps: Dependencies,
  context: Context,
  input: {
    variantId: string;
    quantity: number;
    addressId?: string;
    displayedUnitPricePaise?: string;
    mode: 'set' | 'add';
  },
  toolCallId: string,
  { noteId, displayedCardPrice, tx: choiceTx }: CartWriteOptions = {},
) {
  assertQuantity(input.quantity, context.maxQuantity, input.mode === 'set');
  if (!toolCallId || toolCallId.length > 200) throw new Error('INVALID_INPUT');
  // Model-initiated writes must name a variant the server resolved for this
  // same message; explicit taps on an owned product card (noteId) keep the
  // existing card-action checks instead.
  const guarded =
    !noteId && context.candidates !== undefined && context.clientMessageId !== undefined;
  if (guarded) {
    const candidates = context.candidates!.get(context.userId, context.clientMessageId!);
    const match = assertWriteCandidate(candidates, input);
    const quantity = context.userText
      ? requestedAddQuantity(context.userText, match, candidates!)
      : null;
    if (quantity !== null) {
      assertQuantity(quantity, context.maxQuantity, false);
      if (quantity > match.maxPerOrder) throw new Error('INVALID_QUANTITY');
      input = { ...input, mode: 'add', quantity, displayedUnitPricePaise: match.sellingPaise };
    }
  }
  if (
    !choiceTx &&
    input.addressId &&
    !(await deps.addresses.list(context.userId)).some((item) => item.id === input.addressId)
  )
    throw new Error('ADDRESS_NOT_FOUND');
  const hash = guarded
    ? stableOperationHash({
        messageId: context.clientMessageId!,
        variantId: input.variantId,
        quantity: input.quantity,
        mode: input.mode,
        ...(input.addressId ? { addressId: input.addressId } : {}),
        ...((input.displayedUnitPricePaise ?? displayedCardPrice)
          ? { displayedUnitPricePaise: (input.displayedUnitPricePaise ?? displayedCardPrice)! }
          : {}),
      })
    : hashCanonical(input);
  const write = async (tx: TransactionContext) => {
    if (!choiceTx) await lockAgentThread(tx, context.userId, context.threadId);
    const prior = await sql<{
      request_hash: string;
      result: Json;
    }>`SELECT request_hash,result FROM agent_tool_operations WHERE thread_id=${context.threadId}::uuid AND user_id=${context.userId}::uuid AND tool_call_id=${toolCallId}`.execute(
      tx,
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return prior.rows[0].result;
    }
    if (guarded) {
      const duplicate = await sql<{
        result: Json;
      }>`SELECT result FROM agent_tool_operations WHERE thread_id=${context.threadId}::uuid AND user_id=${context.userId}::uuid AND request_hash=${hash} LIMIT 1`.execute(
        tx,
      );
      if (duplicate.rows[0]) return duplicate.rows[0].result;
    }
    const cart = await deps.cart.getOrCreateActiveCart(
      context.userId,
      choiceTx ? input.addressId : undefined,
      tx,
    );
    if (choiceTx && cart.addressId !== (input.addressId ?? null))
      throw new Error('CONCURRENT_MODIFICATION');
    const quantity =
      input.mode === 'add'
        ? Number(cart.lines.find((line) => line.variantId === input.variantId)?.quantity ?? 0) +
          input.quantity
        : input.quantity;
    assertQuantity(quantity, context.maxQuantity, input.mode === 'set');
    const updated = await deps.cart.putItem(context.userId, input.variantId, String(quantity), {
      expectedVersion: cart.version,
      displayedUnitPricePaise: input.displayedUnitPricePaise ?? displayedCardPrice,
      ...(choiceTx ? { acceptPriceChange: true, requireAvailableQuantity: true } : {}),
      tx,
    });
    const result = {
      addressId: updated.cart.addressId,
      version: updated.cart.version,
      clamped: updated.clamped,
      items: updated.cart.lines.map((line) => ({
        variantId: line.variantId,
        name: sanitizeAgentText(line.productName, 160),
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
      })),
      issues: updated.cart.issues.map((issue) => ({ code: issue.code })),
    } as unknown as Json;
    await sql`INSERT INTO agent_tool_operations(thread_id,tool_call_id,user_id,request_hash,result) VALUES(${context.threadId}::uuid,${toolCallId},${context.userId}::uuid,${hash},${JSON.stringify(result)}::jsonb)`.execute(
      tx,
    );
    if (noteId) {
      await sql`INSERT INTO agent_messages(id,thread_id,role,text,client_message_id) VALUES(${uuidV7()}::uuid,${context.threadId}::uuid,'system_note','Added an item to the cart from a product card.',${noteId}::uuid) ON CONFLICT(thread_id,client_message_id) DO NOTHING`.execute(
        tx,
      );
      await sql`UPDATE agent_threads SET last_message_at=clock_timestamp() WHERE id=${context.threadId}::uuid`.execute(
        tx,
      );
    }
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${context.userId}::uuid,'AGENT_CART_CHANGED','cart',${updated.cart.cartId},${JSON.stringify({ source: 'AGENT', threadId: context.threadId })}::jsonb)`.execute(
      tx,
    );
    return result;
  };
  return choiceTx ? write(choiceTx) : deps.db.transaction().execute(write);
}
export function setAgentCartQuantity(
  deps: Dependencies,
  context: Context,
  input: {
    variantId: string;
    quantity: number;
    addressId?: string;
    displayedUnitPricePaise?: string;
  },
  toolCallId: string,
) {
  return writeAgentCart(deps, context, { ...input, mode: 'set' }, toolCallId);
}
export function addAgentCartItem(
  deps: Dependencies,
  context: Context,
  input: {
    variantId: string;
    quantity: number;
    addressId?: string;
    displayedUnitPricePaise?: string;
  },
  toolCallId: string,
  options?: CartWriteOptions,
) {
  return writeAgentCart(deps, context, { ...input, mode: 'add' }, toolCallId, options);
}

export function createWriteTools(deps: Dependencies, context: Context, kit: AgentToolKit) {
  return [
    kit.define(
      'save_address',
      'Save a written address only when the customer explicitly asks you to add or save it and supplies the street, PIN, contact name and Indian mobile number in their current message. Never invent a location or any field. The address is saved without a delivery location; if required, the customer confirms the location before ordering.',
      z.object({
        line1: z.string().min(1).max(200),
        line2: z.string().max(200).optional(),
        pincode: z.string().regex(/^\d{6}$/),
        contactName: z.string().min(1).max(120),
        contactPhone: z.string().regex(/^(?:\+91)?[6-9]\d{9}$/),
      }),
      async (input, runtime) => {
        const source = context.userText ?? '';
        const asksToSave =
          /\b(add|save|create|store)\b[\s\S]{0,100}\b(address|location)\b|\b(address|location)\b[\s\S]{0,100}\b(add|save|create|store)\b/i.test(
            source,
          );
        const normalized = (value: string) =>
          value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
            .replace(/\s+/g, ' ');
        const inSource = (value: string) => normalized(source).includes(normalized(value));
        const phone = input.contactPhone.replace(/^\+91/, '');
        if (
          !asksToSave ||
          !inSource(input.line1) ||
          !inSource(input.contactName) ||
          !source.replace(/\D/g, '').includes(phone) ||
          !source.includes(input.pincode) ||
          (input.line2 && !inSource(input.line2))
        )
          throw new Error('ADDRESS_SAVE_NOT_REQUESTED');
        if (!runtime.toolCallId) throw new Error('INVALID_INPUT');
        const draft = {
          line1: input.line1.trim(),
          ...(input.line2?.trim() ? { line2: input.line2.trim() } : {}),
          pincode: input.pincode,
          contactName: input.contactName.trim(),
          contactPhone: `+91${phone}`,
          point: null,
        };
        const reference = `agent-address:${createHash('sha256')
          .update(
            `${context.threadId}:${context.clientMessageId ?? runtime.toolCallId}:${hashCanonical(draft)}`,
          )
          .digest('hex')}`;
        const saved = await deps.addresses.create(
          context.userId,
          draft,
          true,
          reference,
          async (tx) => {
            await requireAgentPermission(context.userId, tx);
            const thread =
              await sql`SELECT id FROM agent_threads WHERE id=${context.threadId}::uuid AND user_id=${context.userId}::uuid AND status='active' FOR UPDATE`.execute(
                tx,
              );
            if (!thread.rows.length) throw new Error('THREAD_ARCHIVED');
            await assertAgentCommitAllowed(tx, context.userId, context.threadId);
          },
        );
        const locationRequired = deps.locationRequired ? await deps.locationRequired() : true;
        if (
          locationRequired &&
          !saved.address.point &&
          kit.showCardOnce('delivery-address-required')
        )
          runtime.writer?.({
            event: 'card',
            data: {
              cardId: uuidV7(),
              type: 'info',
              payload: {
                title: 'Address saved',
                description:
                  'Confirm the delivery location when you are there to check products and place an order.',
                options: [
                  {
                    label: 'Confirm location',
                    action: 'open_screen',
                    payload: {
                      screen: 'addresses',
                      addressId: saved.address.id,
                      needsLocation: true,
                    },
                  },
                ],
              },
            },
          });
        return {
          addressId: saved.address.id,
          saved: true,
          locationRequired,
          locationConfirmed: saved.address.point !== null,
        };
      },
    ),
    kit.define(
      'set_cart_item_qty',
      'Set the absolute quantity of a product after the customer asks to change the cart. Use only a variant id from the exact matches returned by product search for this same message. For a new item, pass the current displayed price returned by search. Use zero only when explicitly asked to remove an item.',
      z.object({
        variantId: z.string().uuid().describe('A product variant id returned by search'),
        quantity: z.number().int().min(0).describe('Desired total quantity; zero removes the item'),
        addressId: z.string().uuid().optional().describe('Optional saved address id'),
        displayedUnitPricePaise: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,11})$/)
          .optional()
          .describe('Current sellingPaise returned by product search'),
      }),
      async (input, runtime) => setAgentCartQuantity(deps, context, input, runtime.toolCallId),
    ),
    kit.define(
      'clear_cart',
      'Empty the cart only when the customer asks to clear it or to remove everything. Never use this to make room for a new order without asking.',
      z.object({}),
      async (_input, runtime) => {
        if (!runtime.toolCallId || runtime.toolCallId.length > 200)
          throw new Error('INVALID_INPUT');
        const hash = hashCanonical({ op: 'clear_cart' });
        return deps.db.transaction().execute(async (tx) => {
          const user =
            await sql`SELECT id FROM users WHERE id=${context.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
              tx,
            );
          if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
          await requireAgentPermission(context.userId, tx);
          const thread = await sql<{
            status: string;
          }>`SELECT status FROM agent_threads WHERE id=${context.threadId}::uuid AND user_id=${context.userId}::uuid FOR UPDATE`.execute(
            tx,
          );
          if (!thread.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
          if (thread.rows[0].status !== 'active') throw new Error('THREAD_ARCHIVED');
          await assertAgentCommitAllowed(tx, context.userId, context.threadId);
          const prior = await sql<{
            request_hash: string;
            result: Json;
          }>`SELECT request_hash,result FROM agent_tool_operations WHERE thread_id=${context.threadId}::uuid AND user_id=${context.userId}::uuid AND tool_call_id=${runtime.toolCallId}`.execute(
            tx,
          );
          if (prior.rows[0]) {
            if (prior.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
            return prior.rows[0].result;
          }
          const cart = await deps.cart.get(context.userId, tx);
          const cleared = Boolean(cart && cart.lines.length);
          const result: { cleared: boolean; removedItems: number } = cleared
            ? { cleared: true, removedItems: cart!.lines.length }
            : { cleared: false, removedItems: 0 };
          if (cleared)
            await deps.cart.deleteCart(context.userId, { expectedVersion: cart!.version, tx });
          await sql`INSERT INTO agent_tool_operations(thread_id,tool_call_id,user_id,request_hash,result) VALUES(${context.threadId}::uuid,${runtime.toolCallId},${context.userId}::uuid,${hash},${JSON.stringify(result)}::jsonb)`.execute(
            tx,
          );
          if (cleared) {
            await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${context.userId}::uuid,'AGENT_CART_CLEARED','cart',${cart!.cartId},${JSON.stringify({ source: 'AGENT', threadId: context.threadId })}::jsonb)`.execute(
              tx,
            );
          }
          return result as unknown as Json;
        });
      },
    ),
    kit.define(
      'select_address_for_order',
      'Point the current cart at a saved address. This may switch the serving store and re-evaluate the cart items. Use the ids returned by list_addresses only.',
      z.object({ addressId: z.string().uuid().describe('A saved address id from list_addresses') }),
      async (input, runtime) => {
        if (!runtime.toolCallId || runtime.toolCallId.length > 200)
          throw new Error('INVALID_INPUT');
        const addresses = await deps.addresses.list(context.userId);
        const selected = addresses.find((address) => address.id === input.addressId);
        if (!selected) throw new Error('ADDRESS_NOT_FOUND');
        const hash = hashCanonical({ op: 'select_address', addressId: input.addressId });
        return deps.db.transaction().execute(async (tx) => {
          const user =
            await sql`SELECT id FROM users WHERE id=${context.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
              tx,
            );
          if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
          await requireAgentPermission(context.userId, tx);
          const thread = await sql<{
            status: string;
          }>`SELECT status FROM agent_threads WHERE id=${context.threadId}::uuid AND user_id=${context.userId}::uuid FOR UPDATE`.execute(
            tx,
          );
          if (!thread.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
          if (thread.rows[0].status !== 'active') throw new Error('THREAD_ARCHIVED');
          await assertAgentCommitAllowed(tx, context.userId, context.threadId);
          const prior = await sql<{
            request_hash: string;
            result: Json;
          }>`SELECT request_hash,result FROM agent_tool_operations WHERE thread_id=${context.threadId}::uuid AND user_id=${context.userId}::uuid AND tool_call_id=${runtime.toolCallId}`.execute(
            tx,
          );
          if (prior.rows[0]) {
            if (prior.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
            return prior.rows[0].result;
          }
          const cart = await deps.cart.getOrCreateActiveCart(context.userId, input.addressId, tx);
          const result = {
            addressId: cart.addressId,
            storeId: cart.storeId,
            version: cart.version,
            items: cart.lines.map((line) => ({
              variantId: line.variantId,
              name: sanitizeAgentText(line.productName, 160),
              quantity: line.quantity,
            })),
            issues: cart.issues.map((issue) => ({ code: issue.code })),
          } as unknown as Json;
          await sql`INSERT INTO agent_tool_operations(thread_id,tool_call_id,user_id,request_hash,result) VALUES(${context.threadId}::uuid,${runtime.toolCallId},${context.userId}::uuid,${hash},${JSON.stringify(result)}::jsonb)`.execute(
            tx,
          );
          await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${context.userId}::uuid,'AGENT_CART_ADDRESS','cart',${cart.cartId},${JSON.stringify({ source: 'AGENT', threadId: context.threadId, addressId: input.addressId })}::jsonb)`.execute(
            tx,
          );
          return result;
        });
      },
    ),
    kit.define(
      'report_order_issue',
      'Create a support ticket when a customer asks to report a missing, damaged, wrong or late item, or asks for a person.',
      z.object({
        category: z
          .enum(['missing_item', 'damaged', 'wrong_item', 'late', 'other'])
          .describe('The customer’s issue category'),
        orderId: z.string().uuid().optional().describe('The relevant order id, if known'),
        description: z
          .string()
          .min(1)
          .max(1000)
          .describe('Short factual description supplied by the customer'),
      }),
      async (input, runtime) => {
        const body = sanitizeAgentText(input.description, 1000);
        if (!body) throw new Error('INVALID_INPUT');
        const id = await deps.support.create(
          context.userId,
          {
            category: input.category,
            ...(input.orderId ? { orderId: input.orderId } : {}),
            body,
            reference: `agent:${context.threadId}:${runtime.toolCallId}`.slice(0, 150),
          },
          {
            beforeCreate: async (tx) => {
              await requireAgentPermission(context.userId, tx);
              await assertAgentCommitAllowed(tx, context.userId, context.threadId);
            },
          },
        );
        return { ticketId: id, status: 'OPEN' };
      },
    ),
    kit.define(
      'escalate_to_human',
      'Bring in a human support agent when the customer asks for a person, is upset, or the request cannot be handled by the app or this chat. Summarise the issue briefly without personal details.',
      z.object({
        orderId: z.string().uuid().optional().describe('The relevant order id, if known'),
        summary: z
          .string()
          .min(1)
          .max(1000)
          .describe('Short sanitised summary of what the customer needs'),
      }),
      async (input, runtime) => {
        const body = sanitizeAgentText(input.summary, 1000);
        if (!body) throw new Error('INVALID_INPUT');
        const id = await deps.support.create(
          context.userId,
          {
            category: 'escalation',
            ...(input.orderId ? { orderId: input.orderId } : {}),
            body,
            reference: `agent:${context.threadId}:${runtime.toolCallId}`.slice(0, 150),
          },
          {
            beforeCreate: async (tx) => {
              await requireAgentPermission(context.userId, tx);
              await assertAgentCommitAllowed(tx, context.userId, context.threadId);
            },
          },
        );
        return { ticketId: id, status: 'OPEN' };
      },
    ),
  ];
}
