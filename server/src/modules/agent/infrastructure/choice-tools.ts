import { z } from 'zod';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { Support } from '../../support/contracts/support.js';
import type { AgentCard } from '../contracts/agent.js';
import type { AgentToolKit } from './tool-kit.js';
import { cartChoiceCardPayload, prepareChoice } from './choices.js';

interface Dependencies {
  db: Database;
  addresses: AddressOperations;
  cart: CartService;
  catalog: CatalogQuery;
  support: Support;
}
interface Context {
  userId: string;
  threadId: string;
  confirmTtlSeconds: number;
}
type Writer = ((chunk: unknown) => void) | null;
function card(writer: Writer, type: AgentCard['type'], payload: Record<string, unknown>): void {
  writer?.({ event: 'card', data: { cardId: uuidV7(), type, payload } });
}

/**
 * Ask-for-choice tool: resolves the exact catalog variants for an ambiguous
 * cart request, stores one active choice per thread, and shows the durable
 * cart_choice card. The customer answers by tap (actions API) or by typing,
 * and both paths share the same commit validation.
 */
export function createChoiceTools(deps: Dependencies, context: Context, kit: AgentToolKit) {
  return [
    kit.define(
      'ask_cart_choice',
      'Ask which exact size and quantity to add when a cart request names a product without them. Show the returned question and sizes to the customer.',
      z.object({
        query: z.string().min(1).max(100).describe('Product phrase from the customer message'),
        addressId: z.string().uuid().optional().describe('Optional id of a saved delivery address'),
      }),
      async (input, runtime) => {
        const prepared = await prepareChoice(deps, {
          userId: context.userId,
          threadId: context.threadId,
          query: input.query,
          addressId: input.addressId,
          ttlSeconds: context.confirmTtlSeconds,
        });
        if (!prepared.choice) return { asked: false, clarification: prepared.clarification };
        card(runtime.writer, 'cart_choice', cartChoiceCardPayload(prepared.choice));
        return {
          asked: true,
          question: prepared.question,
          choiceId: prepared.choice.id,
          variants: prepared.choice.variants,
        };
      },
    ),
  ];
}
