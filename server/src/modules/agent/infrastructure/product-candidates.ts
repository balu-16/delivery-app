import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import { normalizeProductText, phraseInText, type ExactCandidate } from './product-resolver.js';
import { addRequestText, parseChoiceAnswer } from './choice-answer.js';

/**
 * Server-resolved candidates shared between assistant search and mutation
 * tools, scoped to the current customer and message. The model can only
 * write a variant the server resolved for that same message.
 */
export class AgentCandidateStore {
  private readonly entries = new Map<string, ExactCandidate[]>();

  static scope(userId: string, messageId: string): string {
    return `${userId}:${messageId}`;
  }

  set(userId: string, messageId: string, candidates: readonly ExactCandidate[]): void {
    this.entries.set(AgentCandidateStore.scope(userId, messageId), [...candidates]);
  }

  get(userId: string, messageId: string): ExactCandidate[] | undefined {
    return this.entries.get(AgentCandidateStore.scope(userId, messageId));
  }
}

export interface CandidateWrite {
  variantId: string;
  quantity: number;
  displayedUnitPricePaise?: string;
}

/**
 * Validate a model-requested write against the server-resolved candidates
 * before entering the write transaction. Throws ITEM_UNAVAILABLE when the
 * variant was never resolved for this message or cannot be sold,
 * PRICE_CHANGED when the confirmed price moved, and INVALID_QUANTITY when
 * the request exceeds the candidate's limit.
 */
export function assertWriteCandidate(
  candidates: readonly ExactCandidate[] | undefined,
  input: CandidateWrite,
): ExactCandidate {
  const match = candidates?.find((candidate) => candidate.variantId === input.variantId);
  if (!match || match.availability === 'OUT_OF_STOCK' || match.availability === 'UNAVAILABLE')
    throw new Error('ITEM_UNAVAILABLE');
  if (
    input.displayedUnitPricePaise !== undefined &&
    input.displayedUnitPricePaise !== match.sellingPaise
  )
    throw new Error('PRICE_CHANGED');
  if (input.quantity > match.maxPerOrder) throw new Error('INVALID_QUANTITY');
  return match;
}

/** The model may select a tool, while the requested size and count come from the customer. */
export function requestedAddQuantity(
  message: string,
  chosen: ExactCandidate,
  candidates: readonly ExactCandidate[],
): number | null {
  const request = addRequestText(message);
  if (request === null) return null;
  const terms = normalizeProductText(request).split(/,|\band\b/);
  const phrase = normalizeProductText(chosen.phrase);
  const matching = terms.filter((term) => phraseInText(phrase, term));
  if (matching.length !== 1) throw new Error('CART_CHOICE_REQUIRED');
  const item = matching[0]!;
  const position = item.indexOf(phrase);
  const answerText = item.slice(0, position) + ' ' + item.slice(position + phrase.length);
  const variants = candidates.filter(
    (candidate) =>
      candidate.productId === chosen.productId &&
      candidate.availability !== 'OUT_OF_STOCK' &&
      candidate.availability !== 'UNAVAILABLE',
  );
  const answer = parseChoiceAnswer(
    answerText,
    variants.map((variant) => ({ variantId: variant.variantId, label: variant.variantName })),
  );
  if (answer?.variantId !== chosen.variantId || answer.quantity === null)
    throw new Error('CART_CHOICE_REQUIRED');
  return answer.quantity;
}

/**
 * Stable operation key per approved item and message: repeated tool calls
 * for the same message, variant, quantity and operation share one hash, so
 * a retry or duplicate call replays instead of adding twice.
 */
export function stableOperationHash(input: {
  messageId: string;
  variantId: string;
  quantity: number;
  mode: 'set' | 'add';
  addressId?: string;
  displayedUnitPricePaise?: string;
}): string {
  return hashCanonical({
    op: 'agent_cart_write',
    messageId: input.messageId,
    variantId: input.variantId,
    quantity: input.quantity,
    mode: input.mode,
    addressId: input.addressId ?? null,
    displayedUnitPricePaise: input.displayedUnitPricePaise ?? null,
  });
}
