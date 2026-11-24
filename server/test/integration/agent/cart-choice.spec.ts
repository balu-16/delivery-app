import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { PostgresAddresses } from '../../../src/modules/addresses/infrastructure/postgres-addresses.js';
import type { AgentCard, AgentEvent } from '../../../src/modules/agent/contracts/agent.js';
import { AgentActions } from '../../../src/modules/agent/infrastructure/actions.js';
import { commitChoice } from '../../../src/modules/agent/infrastructure/choices.js';
import { AgentRuns } from '../../../src/modules/agent/infrastructure/runs.js';
import { AgentRuntime } from '../../../src/modules/agent/infrastructure/runtime.js';
import { AgentThreads } from '../../../src/modules/agent/infrastructure/threads.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { PostgresCartService } from '../../../src/modules/cart/infrastructure/postgres-carts.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;

beforeAll(async () => {
  world = await createP5World({ skipAwsCache: process.env.AWS_P13_INTEGRATION === 'yes' });
}, 300000);
afterAll(async () => {
  if (world) await closeP5World(world);
}, 300000);

test('a typed size survives a reconnect and a competing tap, with one durable cart increment', async () => {
  const db = world.db.db;
  const userId = world.customer;
  const first = await world.variant();
  const second = await world.variant();
  await sql`INSERT INTO consents(user_id,type,version) VALUES(${userId}::uuid,'ai_assistant','1')`.execute(
    db,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('agent_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(db);
  const threads = new AgentThreads(db);
  const { id: threadId } = await threads.current(userId);
  const config: AppConfig = {
    get: async (key) =>
      (
        ({
          agent_max_qty_per_line: 5,
          agent_confirm_ttl_seconds: 300,
        }) as Record<string, unknown>
      )[key] as never,
  };
  const cart = new PostgresCartService(db, world.config, {} as never);
  const addresses = new PostgresAddresses(db);
  const catalogItems = [
    { id: first.id, size: '500 ml' },
    { id: second.id, size: '1 l' },
  ].map(({ id, size }) => ({
    productId: world.product,
    variantId: id,
    name: 'Milk',
    variantName: size,
    sellingPaise: String(first.price),
    maxPerOrder: 5,
    availability: 'IN_STOCK',
  }));
  const dependencies = {
    db,
    cart,
    catalog: { list: async () => ({ items: catalogItems }) },
    addresses,
    support: {},
  } as unknown as ConstructorParameters<typeof AgentActions>[0];
  const runs = new AgentRuns(db);
  const runtime = (): AgentRuntime =>
    Object.assign(Object.create(AgentRuntime.prototype), {
      appConfig: config,
      runs,
      deps: dependencies,
    });
  const send = async (
    text: string,
    clientMessageId = uuidV7(),
    choice?: { choiceId: string; choiceVersion: number },
  ) => {
    const events: AgentEvent[] = [];
    const handled = await runtime().tryLocalReply(
      { userId, threadId, clientMessageId, text, choice },
      (event) => events.push(event),
    );
    return { events, handled };
  };
  const card = (events: AgentEvent[]): AgentCard =>
    events.find((event) => event.event === 'card')!.data as AgentCard;
  const ref = ({ payload }: AgentCard) => ({
    choiceId: String(payload.choiceId),
    choiceVersion: Number(payload.choiceVersion),
  });

  const initial = card((await send('Add milk to cart')).events);
  expect(await cart.get(userId)).toBeNull();
  const picked = card((await send('500 ml', uuidV7(), ref(initial))).events);
  expect(picked.payload.selection).toEqual({ variantId: first.id, quantity: null });
  expect((await send('Cancel order 2', uuidV7(), ref(picked))).handled).toBe(false);
  const choice = ref(picked);
  await expect(
    runs.completeLocal({ userId, threadId, clientMessageId: uuidV7(), text: '2' }, async (tx) => {
      await commitChoice(dependencies, tx, {
        userId,
        threadId,
        ...choice,
        variantId: first.id,
        quantity: 2,
        maxQuantity: 5,
      });
      throw new Error('test rollback after writing the cart');
    }),
  ).rejects.toThrow('test rollback after writing the cart');
  expect(await cart.get(userId)).toBeNull();

  const actions = new AgentActions(dependencies, threads, config);
  const tap = {
    userId,
    threadId,
    cardId: picked.cardId,
    action: 'cart_choice',
    maxQuantity: 5,
    payload: { ...choice, variantId: first.id, quantity: 2 },
    clientActionId: uuidV7(),
  };
  await expect(
    actions.perform({
      ...tap,
      cardId: initial.cardId,
      payload: { ...tap.payload, ...ref(initial) },
    }),
  ).rejects.toThrow('CONCURRENT_MODIFICATION');
  const messageId = uuidV7();
  await Promise.all([actions.perform(tap), send('2', messageId, choice)]);
  await expect(actions.perform({ ...tap, clientActionId: uuidV7() })).resolves.toMatchObject({
    replayed: true,
  });
  await expect(
    actions.perform({ ...tap, payload: { ...tap.payload, quantity: 1 } }),
  ).rejects.toThrow('DRAFT_NOT_PENDING');
  expect((await cart.get(userId))?.lines).toMatchObject([{ variantId: first.id, quantity: '2' }]);

  const next = card((await send('Add milk to cart')).events);
  const replay = await send('2', messageId, choice);
  expect(
    replay.events.some((e) => e.event === 'message.delta' && e.data.text.includes('cart')),
  ).toBe(true);
  expect((await cart.get(userId))?.lines[0]?.quantity).toBe('2');
  await expect(
    actions.perform({ ...tap, payload: { ...tap.payload, ...ref(next) } }),
  ).rejects.toThrow('RESOURCE_NOT_FOUND');
  const nextTap = {
    ...tap,
    cardId: next.cardId,
    payload: { ...tap.payload, ...ref(next), quantity: 1 },
  };
  await addresses.setDefault(userId, world.otherAddress);
  await expect(actions.perform(nextTap)).rejects.toThrow('CONCURRENT_MODIFICATION');
  await addresses.setDefault(userId, world.address);
  await world.stock(world.store, first.id, 0n);
  catalogItems[0]!.availability = 'OUT_OF_STOCK';
  await expect(actions.perform(nextTap)).rejects.toThrow('INVENTORY_INSUFFICIENT');
  expect((await cart.get(userId))?.lines[0]?.quantity).toBe('2');
  const history = (await threads.messages(userId, threadId)).messages.flatMap(
    (message) => message.cards,
  );
  expect(history.find((c) => c.cardId === initial.cardId)?.payload.status).toBe('superseded');
  expect(history.find((c) => c.cardId === picked.cardId)?.payload).toMatchObject({
    status: 'committed',
    selection: { variantId: first.id, quantity: 2 },
  });
  expect(history.find((c) => c.cardId === next.cardId)?.payload.status).toBe('stale');
  const replacement = history.at(-1)!;
  expect(replacement.payload.variants).toMatchObject([{ variantId: second.id }]);
  const typed = await send('1', uuidV7(), ref(replacement));
  expect(typed.events).toContainEqual(
    expect.objectContaining({
      event: 'message.delta',
      data: { text: 'Added 1 × Milk to your cart.' },
    }),
  );
  const reopened = (await threads.messages(userId, threadId)).messages.flatMap(
    (message) => message.cards,
  );
  expect(reopened.find((c) => c.cardId === replacement.cardId)?.payload).toMatchObject({
    status: 'committed',
    selection: { variantId: second.id, quantity: 1, answeredInMessage: true },
  });
  expect(card((await send('Where is my cart?')).events).payload.options).toEqual([
    { label: 'Open cart', action: 'open_screen', payload: { screen: 'cart' } },
  ]);
  await expect(
    runs.begin({
      userId,
      threadId,
      clientMessageId: uuidV7(),
      text: 'Find my usual',
      dailyTurns: 1,
      dailyTokens: 1000,
      outputReservation: 100,
    }),
  ).resolves.toMatchObject({ kind: 'started' });
}, 300000);
