import { z } from 'zod';
import { sql } from 'kysely';
import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json } from '../../../platform/database/database.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { Support } from '../../support/contracts/support.js';
import { assertQuantity, sanitizeAgentText } from './guards.js';
import type { AgentToolKit } from './tool-kit.js';
import { requireAgentPermission } from './security.js';

interface Dependencies {
  db: Database;
  addresses: AddressOperations;
  cart: CartService;
  support: Support;
}
interface Context {
  userId: string;
  threadId: string;
  maxQuantity: number;
}

/** Absolute quantity writes are audited and replayed by the model's tool-call id. */
async function writeAgentCart(
  deps: Dependencies,
  context: Context,
  input: { variantId: string; quantity: number; addressId?: string; mode: 'set' | 'add' },
  toolCallId: string,
  noteId?: string,
) {
  assertQuantity(input.quantity, context.maxQuantity, input.mode === 'set');
  if (!toolCallId || toolCallId.length > 200) throw new Error('INVALID_INPUT');
  const addresses = await deps.addresses.list(context.userId);
  const current = await deps.cart.get(context.userId);
  const address = input.addressId
    ? addresses.find((item) => item.id === input.addressId)
    : (addresses.find((item) => item.id === current?.addressId) ??
      addresses.find((item) => item.isDefault));
  if (!address) throw new Error(input.addressId ? 'ADDRESS_NOT_FOUND' : 'ADDRESS_REQUIRED');
  const hash = hashCanonical(input);
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
    const cart = await deps.cart.getOrCreateActiveCart(context.userId, address.id, tx);
    const quantity =
      input.mode === 'add'
        ? Number(cart.lines.find((line) => line.variantId === input.variantId)?.quantity ?? 0) +
          input.quantity
        : input.quantity;
    assertQuantity(quantity, context.maxQuantity, input.mode === 'set');
    const updated = await deps.cart.putItem(context.userId, input.variantId, String(quantity), {
      expectedVersion: cart.version,
      addressId: address.id,
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
  });
}
export function setAgentCartQuantity(
  deps: Dependencies,
  context: Context,
  input: { variantId: string; quantity: number; addressId?: string },
  toolCallId: string,
) {
  return writeAgentCart(deps, context, { ...input, mode: 'set' }, toolCallId);
}
export function addAgentCartItem(
  deps: Dependencies,
  context: Context,
  input: { variantId: string; quantity: number; addressId?: string },
  toolCallId: string,
  noteId?: string,
) {
  return writeAgentCart(deps, context, { ...input, mode: 'add' }, toolCallId, noteId);
}

export function createWriteTools(deps: Dependencies, context: Context, kit: AgentToolKit) {
  return [
    kit.define(
      'set_cart_item_qty',
      'Set the absolute quantity of a product after the customer asks to change the cart. Use zero only when explicitly asked to remove an item.',
      z.object({
        variantId: z.string().uuid().describe('A product variant id returned by search'),
        quantity: z.number().int().min(0).describe('Desired total quantity; zero removes the item'),
        addressId: z.string().uuid().optional().describe('Optional saved address id'),
      }),
      async (input, runtime) => setAgentCartQuantity(deps, context, input, runtime.toolCallId),
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
          { beforeCreate: (tx) => requireAgentPermission(context.userId, tx) },
        );
        return { ticketId: id, status: 'OPEN' };
      },
    ),
  ];
}
