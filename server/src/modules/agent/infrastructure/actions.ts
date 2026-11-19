import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import type { Database } from '../../../platform/database/database.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { Support } from '../../support/contracts/support.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { addAgentCartItem } from './write-tools.js';
import { choiceNeedsRefresh, choiceReply, commitChoice, refreshChoice } from './choices.js';
import { lockAgentThread } from './security.js';
import type { AgentThreads } from './threads.js';

const cartPayload = z
  .object({
    variantId: z.string().uuid(),
    quantity: z.number().int().positive(),
    addressId: z.string().uuid().optional(),
    displayedUnitPricePaise: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,11})$/)
      .optional(),
  })
  .strict();
const choicePayload = z
  .object({
    choiceId: z.string().uuid(),
    choiceVersion: z.number().int().positive().optional(),
    variantId: z.string().uuid(),
    quantity: z.number().int().positive(),
    addressId: z.string().uuid().optional(),
  })
  .strict();
interface Dependencies {
  db: Database;
  addresses: AddressOperations;
  cart: CartService;
  catalog: CatalogQuery;
  support: Support;
}
export class AgentActions {
  constructor(
    private readonly deps: Dependencies,
    private readonly threads: AgentThreads,
    private readonly config: AppConfig,
  ) {}
  async perform(input: {
    userId: string;
    threadId: string;
    cardId: string;
    action: string;
    payload: unknown;
    maxQuantity: number;
    clientActionId?: string;
  }) {
    if (input.action !== 'add_to_cart' && input.action !== 'cart_choice')
      throw new Error('INVALID_INPUT');
    const active =
      await sql`SELECT 1 FROM agent_jobs WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND state IN ('queued','running') LIMIT 1`.execute(
        this.deps.db,
      );
    if (active.rows.length) throw new Error('RUN_IN_PROGRESS');
    if (input.action === 'cart_choice') return this.commitCartChoice(input);
    const payload = cartPayload.parse(input.payload);
    if (payload.quantity > input.maxQuantity) throw new Error('INVALID_QUANTITY');
    const rows = await sql<{
      card: { type?: unknown; payload?: { options?: unknown; items?: unknown } };
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
        hashCanonical(option.payload) === hashCanonical({ ...payload, quantity: 1 }),
    );
    if (!authorized) throw new Error('RESOURCE_NOT_FOUND');
    const cardItems = Array.isArray(card.payload?.items) ? card.payload.items : [];
    const displayed = cardItems.find(
      (item) => item && typeof item === 'object' && item.variantId === payload.variantId,
    );
    const cardPrice =
      displayed && typeof displayed === 'object'
        ? (displayed.sellingPaise ?? displayed.unitPricePaise)
        : undefined;
    if (
      typeof cardPrice !== 'string' ||
      !/^(0|[1-9][0-9]{0,11})$/.test(cardPrice) ||
      (payload.displayedUnitPricePaise !== undefined &&
        payload.displayedUnitPricePaise !== cardPrice)
    )
      throw new Error('PRICE_CHANGED');
    const displayedUnitPricePaise = cardPrice;
    const reference = input.clientActionId
      ? `card:${input.cardId}:${input.clientActionId}`
      : `card:${input.cardId}:${payload.variantId}`;
    const hash = createHash('sha256').update(reference).digest('hex');
    const messageId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const result = await addAgentCartItem(
      this.deps,
      { userId: input.userId, threadId: input.threadId, maxQuantity: input.maxQuantity },
      payload,
      reference,
      { noteId: messageId, displayedCardPrice: displayedUnitPricePaise },
    );
    return { result, messageId };
  }

  /**
   * Commit a tapped cart choice. Stale outcomes map to the client's
   * pick-again messages; a fresh choice is prepared so the next message
   * re-asks with current sizes instead of failing outright.
   */
  private async commitCartChoice(input: {
    userId: string;
    threadId: string;
    cardId: string;
    payload: unknown;
    maxQuantity: number;
    clientActionId?: string;
  }) {
    const payload = choicePayload.parse(input.payload);
    if (payload.quantity > input.maxQuantity) throw new Error('INVALID_QUANTITY');
    const card = await sql<{
      card: { type?: unknown; payload?: { choiceId?: unknown; choiceVersion?: unknown } };
    }>`SELECT c.value AS card FROM agent_messages m
      JOIN agent_threads t ON t.id=m.thread_id
      CROSS JOIN LATERAL jsonb_array_elements(m.cards) AS c(value)
      WHERE t.user_id=${input.userId}::uuid AND t.id=${input.threadId}::uuid AND t.status='active' AND c.value->>'cardId'=${input.cardId} LIMIT 1`.execute(
      this.deps.db,
    );
    const cardChoice = card.rows[0]?.card;
    if (cardChoice?.type !== 'cart_choice' || cardChoice.payload?.choiceId !== payload.choiceId)
      throw new Error('RESOURCE_NOT_FOUND');
    const version = cardChoice.payload.choiceVersion;
    if (payload.choiceVersion !== undefined && payload.choiceVersion !== version)
      throw new Error('CONCURRENT_MODIFICATION');
    const reference = {
      userId: input.userId,
      threadId: input.threadId,
      choiceId: payload.choiceId,
      ...(typeof version === 'number' ? { choiceVersion: version } : {}),
    };
    try {
      return await this.deps.db.transaction().execute(async (tx) => {
        await lockAgentThread(tx, input.userId, input.threadId);
        return commitChoice(this.deps, tx, {
          ...reference,
          variantId: payload.variantId,
          quantity: payload.quantity,
          maxQuantity: input.maxQuantity,
        });
      });
    } catch (error) {
      if (error instanceof Error && choiceNeedsRefresh(error.message)) {
        const ttlSeconds = await this.config.get('agent_confirm_ttl_seconds');
        await refreshChoice(this.deps, { ...reference, ttlSeconds }, async (tx, choice) => {
          const reply = choiceReply(choice, 'Please review the current options. ');
          await this.threads.append(
            input.userId,
            input.threadId,
            'assistant',
            reply.text,
            reply.cards,
            undefined,
            tx,
          );
        });
      }
      throw error;
    }
  }
}
