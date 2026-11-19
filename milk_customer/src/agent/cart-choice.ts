import type { AgentCard } from './types';

/** One selectable catalog variant carried by a `cart_choice` card. */
export interface CartChoiceVariant {
  variantId: string;
  label: string;
  sellingPaise?: string;
}

/** A persisted, validated choice submission (safe to retry with the same id). */
export interface PendingCartChoice {
  cardId: string;
  choiceId: string;
  choiceVersion?: number;
  variantId: string;
  quantity: number;
  actionId: string;
}

export interface CartChoiceReference { choiceId: string; choiceVersion: number }

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

function variantLabel(item: Record<string, unknown>): string {
  return text(item.label) || text(item.variantName) || text(item.size) || text(item.name) || '';
}

function variantId(item: Record<string, unknown>): string {
  const direct = text(item.variantId);
  if (direct) return direct;
  const payload = item.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const nested = text((payload as Record<string, unknown>).variantId);
    if (nested) return nested;
  }
  return '';
}

function priceOf(item: Record<string, unknown>): string | undefined {
  const price = text(item.sellingPaise) || text(item.unitPricePaise);
  if (price && /^(0|[1-9][0-9]{0,11})$/.test(price)) return price;
  const payload = item.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const nested = text((payload as Record<string, unknown>).sellingPaise);
    if (nested && /^(0|[1-9][0-9]{0,11})$/.test(nested)) return nested;
  }
  return undefined;
}

/**
 * Read the exact catalog variants from a `cart_choice` card. Accepts both the
 * direct `variants` list and the options list used elsewhere in the transcript.
 */
export function cartChoiceVariants(card: AgentCard): CartChoiceVariant[] {
  if (card.type !== 'cart_choice') return [];
  const found: CartChoiceVariant[] = [];
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const item = raw as Record<string, unknown>;
    if (text(item.availability).toUpperCase() === 'OUT_OF_STOCK') return;
    const id = variantId(item);
    const label = variantLabel(item);
    if (!id || !label) return;
    if (found.some((existing) => existing.variantId === id)) return;
    const variant: CartChoiceVariant = { variantId: id, label };
    const price = priceOf(item);
    if (price) variant.sellingPaise = price;
    found.push(variant);
  };
  if (Array.isArray(card.payload.variants)) card.payload.variants.forEach(push);
  if (Array.isArray(card.payload.options)) card.payload.options.forEach(push);
  if (found.length === 0 && Array.isArray(card.payload.items)) card.payload.items.forEach(push);
  return found;
}

export function cartChoiceQuestion(card: AgentCard): string {
  return text(card.payload.question) || text(card.payload.title) || 'Which one would you like?';
}

export function cartChoiceId(card: AgentCard): string {
  return text(card.payload.choiceId) || text(card.payload.draftId) || card.cardId;
}

export function cartChoiceReference(card: AgentCard): CartChoiceReference | undefined {
  const choiceId = card.payload.choiceId;
  const choiceVersion = card.payload.choiceVersion;
  return typeof choiceId === 'string' && uuid.test(choiceId) &&
    typeof choiceVersion === 'number' && Number.isSafeInteger(choiceVersion) && choiceVersion > 0
    ? { choiceId, choiceVersion } : undefined;
}

export function cartChoiceSelection(card: AgentCard): { variantId?: string; quantity?: number } {
  const selection = card.payload.selection;
  if (!selection || typeof selection !== 'object') return {};
  const { variantId, quantity } = selection as Record<string, unknown>;
  return {
    ...(typeof variantId === 'string' ? { variantId } : {}),
    ...(typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity > 0 ? { quantity } : {}),
  };
}

export function cartChoiceExpiresAt(card: AgentCard): number | null {
  const raw = text(card.payload.expiresAt);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
}

export function cartChoiceSubmitted(card: AgentCard): boolean {
  return ['submitted', 'committed', 'completed', 'executed', 'approved'].includes(text(card.payload.status));
}

export function cartChoiceOpen(card: AgentCard): boolean {
  if (card.type !== 'cart_choice') return false;
  const status = text(card.payload.status);
  const expiry = cartChoiceExpiresAt(card);
  return (!status || status === 'pending') && (expiry === null || expiry > Date.now());
}

export const pendingCartChoiceKey = (threadId: string) => `@dairydirect/agent-cart-choice/${threadId}`;

/** Restore only a complete choice submission; anything else must not be replayed. */
export function readPendingCartChoice(raw: string): PendingCartChoice | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.cardId !== 'string' || !uuid.test(item.cardId)) return null;
    if (typeof item.choiceId !== 'string' || !item.choiceId) return null;
    if (typeof item.variantId !== 'string' || !uuid.test(item.variantId)) return null;
    if (typeof item.actionId !== 'string' || !uuid.test(item.actionId)) return null;
    if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) return null;
    const version = item.choiceVersion;
    if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) return null;
    return { cardId: item.cardId, choiceId: item.choiceId, variantId: item.variantId, quantity: item.quantity, actionId: item.actionId, ...(version === undefined ? {} : { choiceVersion: version }) };
  } catch { return null; }
}
