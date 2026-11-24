import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { AgentCard, AgentChoiceReference } from '../contracts/agent.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { Support } from '../../support/contracts/support.js';
import { resolveProducts } from './product-resolver.js';
import type { ResolverItem } from './product-resolver.js';
import { addAgentCartItem } from './write-tools.js';
import type { ChoiceAnswer } from './choice-answer.js';
import { lockAgentThread } from './security.js';

export { parseChoiceAnswer } from './choice-answer.js';

export interface ChoiceVariant {
  productId: string;
  variantId: string;
  label: string;
  sellingPaise: string;
}

interface ChoiceDelivery {
  addressId?: string;
  defaultAddressId?: string | null;
}

export interface ChoiceRow {
  id: string;
  thread_id: string;
  user_id: string;
  version: number;
  variants: ChoiceVariant[];
  delivery: ChoiceDelivery;
  question: string;
  status: 'pending' | 'committing' | 'committed' | 'expired' | 'stale' | 'superseded';
  expires_at: Date;
  result: Json | null;
  selection: ChoiceAnswer | null;
}

export interface ChoiceRef {
  userId: string;
  threadId: string;
  choiceId: string;
  choiceVersion?: number;
}

interface ChoiceDeps {
  db: Database;
  addresses: AddressOperations;
  cart: CartService;
  catalog: CatalogQuery;
  support: Support;
}

const text = (value: unknown, max = 160): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

function narrow(value: unknown, fallbackMax: number): ResolverItem {
  const item = (value ?? {}) as Record<string, unknown>;
  return {
    productId: text(item.productId, 40),
    variantId: text(item.variantId, 40),
    name: text(item.name),
    variantName: text(item.variantName),
    sellingPaise: text(item.sellingPaise, 20),
    availability:
      typeof item.availability === 'string' ? text(item.availability, 40) : 'CHECK_AT_CHECKOUT',
    maxPerOrder: typeof item.maxPerOrder === 'number' ? item.maxPerOrder : fallbackMax,
  };
}

const sellable = (item: ResolverItem): boolean =>
  Boolean(item.variantId && item.sellingPaise) &&
  item.availability !== 'OUT_OF_STOCK' &&
  item.availability !== 'UNAVAILABLE' &&
  item.maxPerOrder > 0;

/** Resolve the customer's default delivery context for a choice. */
async function choiceDelivery(
  deps: Pick<ChoiceDeps, 'addresses' | 'cart'>,
  userId: string,
  addressId?: string,
): Promise<ChoiceDelivery> {
  const addresses = await deps.addresses.list(userId);
  const defaultAddressId = addresses.find((address) => address.isDefault)?.id ?? null;
  if (addressId) {
    if (!addresses.some((address) => address.id === addressId))
      throw new Error('ADDRESS_NOT_FOUND');
    return { addressId, defaultAddressId };
  }
  if (defaultAddressId) return { addressId: defaultAddressId, defaultAddressId };
  const cart = await deps.cart.get(userId);
  return {
    addressId: addresses.find((address) => address.id === cart?.addressId)?.id,
    defaultAddressId,
  };
}

export async function choiceOptions(
  deps: ChoiceDeps,
  input: { userId: string; query: string; addressId?: string },
) {
  const delivery = await choiceDelivery(deps, input.userId, input.addressId);
  const addressId = delivery.addressId;
  const listed = addressId
    ? await deps.catalog.list(input.userId, addressId, { q: input.query.slice(0, 100), limit: 25 })
    : await deps.catalog.preview();
  const items = listed.items.map((value) => narrow(value, 1));
  const resolution = resolveProducts(input.query, items);
  const exact = resolution.exact.filter(sellable);
  if (resolution.requested.length !== 1 || !exact.length) {
    return {
      offer: null,
      clarification:
        resolution.requested.length === 1 && resolution.exact.length
          ? 'That size is out of stock right now. Please pick another size or product.'
          : 'Which product did you mean? Please name it exactly as shown in the catalog.',
    };
  }
  const product = exact[0]!.name;
  const variants: ChoiceVariant[] = exact.map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    label: item.variantName || item.name,
    sellingPaise: item.sellingPaise,
  }));
  return { offer: { product, variants, delivery, question: choiceQuestion(product, variants) } };
}

export async function prepareChoice(
  deps: ChoiceDeps,
  input: {
    userId: string;
    threadId: string;
    query: string;
    addressId?: string;
    ttlSeconds: number;
  },
) {
  const { offer, clarification } = await choiceOptions(deps, input);
  if (!offer) return { choice: null, clarification };
  const choice = await deps.db.transaction().execute(async (tx) => {
    await lockAgentThread(tx, input.userId, input.threadId);
    return insertChoice(tx, input, offer.variants, offer.delivery, offer.question);
  });
  return { choice, question: offer.question, product: offer.product };
}

function choiceQuestion(product: string, variants: ChoiceVariant[]) {
  return variants.length === 1
    ? `How many packs of ${product} (${variants[0]!.label})?`
    : `Which size of ${product}? ${variants.map((variant) => variant.label).join(', ')}.`;
}

export async function insertChoice(
  tx: TransactionContext,
  input: { userId: string; threadId: string; ttlSeconds: number },
  variants: ChoiceVariant[],
  delivery: ChoiceDelivery,
  question: string,
): Promise<ChoiceRow> {
  await sql`UPDATE agent_cart_choices SET status='superseded',updated_at=clock_timestamp()
    WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND status='pending'`.execute(
    tx,
  );
  const prior = await sql<{ version: number }>`SELECT COALESCE(max(version),0) AS version
    FROM agent_cart_choices WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid`.execute(
    tx,
  );
  const id = uuidV7();
  const version = Number(prior.rows[0]?.version ?? 0) + 1;
  const inserted = await sql<ChoiceRow>`INSERT INTO agent_cart_choices(
    id,thread_id,user_id,version,variants,delivery,question,status,expires_at)
    VALUES(${id}::uuid,${input.threadId}::uuid,${input.userId}::uuid,${version},${JSON.stringify(variants)}::jsonb,
    ${JSON.stringify(delivery)}::jsonb,${question},'pending',
    clock_timestamp() + ${input.ttlSeconds} * interval '1 second') RETURNING *`.execute(tx);
  return inserted.rows[0]!;
}

async function ownedChoice(db: Database | TransactionContext, input: ChoiceRef) {
  const found = await sql<
    ChoiceRow & { expired: boolean }
  >`SELECT *,expires_at<=clock_timestamp() AS expired
    FROM agent_cart_choices WHERE id=${input.choiceId}::uuid AND thread_id=${input.threadId}::uuid
    AND user_id=${input.userId}::uuid`.execute(db);
  const row = found.rows[0];
  if (!row) throw new Error('RESOURCE_NOT_FOUND');
  if (input.choiceVersion !== undefined && input.choiceVersion !== row.version)
    throw new Error('CONCURRENT_MODIFICATION');
  return row;
}

function requirePending(row: ChoiceRow & { expired: boolean }) {
  if (row.status !== 'pending') throw new Error('DRAFT_NOT_PENDING');
  if (row.expired) throw new Error('DRAFT_EXPIRED');
}

export async function saveChoiceAnswer(
  tx: TransactionContext,
  input: ChoiceRef,
  answer: ChoiceAnswer,
  maxQuantity: number,
): Promise<ChoiceRow> {
  const row = await ownedChoice(tx, input);
  requirePending(row);
  if (answer.quantity !== null && answer.quantity > maxQuantity)
    throw new Error('INVALID_QUANTITY');
  if (answer.variantId && !row.variants.some((variant) => variant.variantId === answer.variantId))
    throw new Error('INVALID_INPUT');
  const question = answer.variantId
    ? 'How many packs?'
    : `Which size? ${row.variants.map((variant) => variant.label).join(', ')}.`;
  const changed = await sql<ChoiceRow>`UPDATE agent_cart_choices
    SET version=version+1,selection=${JSON.stringify(answer)}::jsonb,question=${question},updated_at=clock_timestamp()
    WHERE id=${row.id}::uuid RETURNING *`.execute(tx);
  return changed.rows[0]!;
}

/** The caller holds the account and thread locks. Choice, cart and receipt share its transaction. */
export async function commitChoice(
  deps: ChoiceDeps,
  tx: TransactionContext,
  input: ChoiceRef & {
    variantId: string;
    quantity: number;
    maxQuantity: number;
    answeredInMessage?: true;
  },
): Promise<{ result: Json; replayed: boolean }> {
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > input.maxQuantity
  )
    throw new Error('INVALID_QUANTITY');
  const row = await ownedChoice(tx, input);
  if (input.choiceVersion === undefined && row.selection !== null && row.status === 'pending')
    throw new Error('CONCURRENT_MODIFICATION');
  if (row.status === 'committed') {
    if (row.selection?.variantId === input.variantId && row.selection.quantity === input.quantity)
      return { result: row.result ?? {}, replayed: true };
    throw new Error('DRAFT_NOT_PENDING');
  }
  requirePending(row);
  // A pre-upgrade write may have persisted the cart before recording the choice.
  const old = await sql`SELECT 1 FROM agent_tool_operations WHERE thread_id=${input.threadId}::uuid
    AND user_id=${input.userId}::uuid AND starts_with(tool_call_id,${`choice:${row.id}:`}) LIMIT 1`.execute(
    tx,
  );
  if (old.rows.length) throw new Error('DRAFT_NOT_PENDING');
  const variant = row.variants.find((candidate) => candidate.variantId === input.variantId);
  if (!variant) throw new Error('INVALID_INPUT');
  const addressId = row.delivery?.addressId;
  const defaultAddress = await sql<{ id: string }>`SELECT id::text FROM addresses
    WHERE user_id=${input.userId}::uuid AND is_default AND deleted_at IS NULL`.execute(tx);
  const expectedDefault =
    row.delivery?.defaultAddressId === undefined
      ? (addressId ?? null)
      : row.delivery.defaultAddressId;
  if ((defaultAddress.rows[0]?.id ?? null) !== expectedDefault)
    throw new Error('CONCURRENT_MODIFICATION');
  const result = await addAgentCartItem(
    deps,
    { userId: input.userId, threadId: input.threadId, maxQuantity: input.maxQuantity },
    {
      variantId: input.variantId,
      quantity: input.quantity,
      ...(addressId ? { addressId } : {}),
      displayedUnitPricePaise: variant.sellingPaise,
    },
    `choice:${row.id}`,
    { tx },
  );
  const selection = {
    variantId: input.variantId,
    quantity: input.quantity,
    ...(input.answeredInMessage ? { answeredInMessage: true } : {}),
  };
  await sql`UPDATE agent_cart_choices SET status='committed',selection=${JSON.stringify(selection)}::jsonb,
    result=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
    tx,
  );
  return { result, replayed: false };
}

export const choiceNeedsRefresh = (code: string) =>
  ['PRICE_CHANGED', 'ITEM_UNAVAILABLE', 'INVENTORY_INSUFFICIENT', 'DRAFT_EXPIRED'].includes(code);

/** Refresh the exact prompt that failed, without superseding a newer choice. */
export async function refreshChoice<T>(
  deps: ChoiceDeps,
  input: ChoiceRef & { ttlSeconds: number },
  publish: (tx: TransactionContext, choice: ChoiceRow | null) => Promise<T>,
): Promise<T> {
  const current = await ownedChoice(deps.db, input);
  const productId = current.variants[0]?.productId;
  const addressId = current.delivery?.addressId;
  const listed = !productId
    ? { items: [] }
    : addressId
      ? await deps.catalog.list(input.userId, addressId, { product: productId, limit: 25 })
      : await deps.catalog.preview();
  const fresh = listed.items
    .map((item) => narrow(item, 1))
    .filter((item) => item.productId === productId && sellable(item));
  const variants = fresh.map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    label: item.variantName || item.name,
    sellingPaise: item.sellingPaise,
  }));
  return deps.db.transaction().execute(async (tx) => {
    await lockAgentThread(tx, input.userId, input.threadId);
    const row = await ownedChoice(tx, { ...input, choiceVersion: current.version });
    if (row.status !== 'pending') throw new Error('DRAFT_NOT_PENDING');
    const question = variants.length ? choiceQuestion(fresh[0]!.name, variants) : '';
    await sql`UPDATE agent_cart_choices SET status=${row.expired ? 'expired' : 'stale'},
      updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(tx);
    const next = variants.length
      ? await insertChoice(tx, input, variants, current.delivery ?? {}, question)
      : null;
    return publish(tx, next);
  });
}

/** Latest pending choice for typed-answer routing. */
export async function pendingChoice(
  db: Database,
  userId: string,
  threadId: string,
  reference?: AgentChoiceReference,
): Promise<ChoiceRow | null> {
  const found = await sql<ChoiceRow>`SELECT * FROM agent_cart_choices
    WHERE thread_id=${threadId}::uuid AND user_id=${userId}::uuid
    AND ${reference ? sql`id=${reference.choiceId}::uuid` : sql`status='pending'`} LIMIT 1`.execute(
    db,
  );
  const row = found.rows[0];
  if (!row) return null;
  return { ...row, variants: Array.isArray(row.variants) ? (row.variants as ChoiceVariant[]) : [] };
}

export function choiceReply(
  choice: ChoiceRow | null,
  prefix = '',
): { text: string; cards: AgentCard[] } {
  if (!choice)
    return { text: 'That item is no longer available. Please pick another product.', cards: [] };
  return {
    text: prefix + choice.question,
    cards: [{ cardId: uuidV7(), type: 'cart_choice', payload: cartChoiceCardPayload(choice) }],
  };
}

/** Card payload readable as text for older builds. */
export function cartChoiceCardPayload(choice: ChoiceRow): Record<string, unknown> {
  return {
    choiceId: choice.id,
    choiceVersion: choice.version,
    selection: choice.selection,
    question: choice.question,
    message: choice.question,
    variants: choice.variants.map((variant) => ({
      variantId: variant.variantId,
      label: variant.label,
      sellingPaise: variant.sellingPaise,
    })),
    expiresAt: choice.expires_at.toISOString(),
  };
}
