import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import type { Database } from '../../../platform/database/database.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { Support } from '../../support/contracts/support.js';
import { addAgentCartItem } from './write-tools.js';

const cartPayload = z
  .object({ variantId: z.string().uuid(), quantity: z.literal(1), addressId: z.string().uuid() })
  .strict();
interface Dependencies {
  db: Database;
  addresses: AddressOperations;
  cart: CartService;
  support: Support;
}
export class AgentActions {
  constructor(private readonly deps: Dependencies) {}
  async perform(input: {
    userId: string;
    threadId: string;
    cardId: string;
    action: string;
    payload: unknown;
    maxQuantity: number;
  }) {
    if (input.action !== 'add_to_cart') throw new Error('INVALID_INPUT');
    const payload = cartPayload.parse(input.payload);
    const rows = await sql<{
      card: { type?: unknown; payload?: { options?: unknown } };
    }>`SELECT c.value AS card FROM agent_messages m JOIN agent_threads t ON t.id=m.thread_id
      CROSS JOIN LATERAL jsonb_array_elements(m.cards) AS c(value)
      WHERE t.user_id=${input.userId}::uuid AND t.id=${input.threadId}::uuid AND t.status='active' AND c.value->>'cardId'=${input.cardId} LIMIT 1`.execute(
      this.deps.db,
    );
    const card = rows.rows[0]?.card;
    if (!card || card.type !== 'product_list' || !Array.isArray(card.payload?.options))
      throw new Error('RESOURCE_NOT_FOUND');
    const authorized = card.payload.options.some(
      (option) =>
        option &&
        typeof option === 'object' &&
        option.action === input.action &&
        hashCanonical(option.payload) === hashCanonical(payload),
    );
    if (!authorized) throw new Error('RESOURCE_NOT_FOUND');
    const reference = `card:${input.cardId}:${payload.variantId}`;
    const hash = createHash('sha256').update(reference).digest('hex');
    const messageId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const result = await addAgentCartItem(
      this.deps,
      { userId: input.userId, threadId: input.threadId, maxQuantity: input.maxQuantity },
      payload,
      reference,
      messageId,
    );
    return { result, messageId };
  }
}
