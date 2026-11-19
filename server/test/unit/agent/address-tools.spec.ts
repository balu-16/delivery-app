import { jest } from '@jest/globals';
import { createReadTools } from '../../../src/modules/agent/infrastructure/read-tools.js';
import { createWriteTools } from '../../../src/modules/agent/infrastructure/write-tools.js';
import { AgentToolKit } from '../../../src/modules/agent/infrastructure/tool-kit.js';

type TestTool = {
  invoke(
    input: Record<string, unknown>,
    runtime: { toolCallId: string; writer?: (event: { event: string }) => void },
  ): Promise<string>;
};

test('product searches work without an address and do not claim store stock', async () => {
  const deps = {
    addresses: { list: async () => [] },
    cart: { get: async () => null },
    appConfig: { get: async () => 10 },
    catalog: {
      preview: async () => ({
        items: [
          {
            productId: 'product',
            variantId: 'variant',
            name: 'Butter',
            variantName: '100 g',
            sellingPaise: '6000',
          },
          {
            productId: 'product2',
            variantId: 'variant2',
            name: 'Curd',
            variantName: '400 g',
            sellingPaise: '4500',
          },
        ],
      }),
    },
  };
  const tool = createReadTools(
    deps as never,
    { userId: 'user', locale: 'en' },
    new AgentToolKit(5),
  ).find((item) => item.name === 'search_products')! as unknown as TestTool;
  const events: { event: string }[] = [];
  const runtime = {
    toolCallId: 'search',
    writer: (event: { event: string }) => events.push(event),
  };
  const outcomes = await Promise.all([
    tool.invoke({ query: 'butter' }, runtime),
    tool.invoke({ query: 'curd' }, runtime),
  ]);
  expect(outcomes.map((result) => JSON.parse(result).data.addressId)).toEqual([null, null]);
  expect(outcomes.map((result) => JSON.parse(result).data.items[0].availability)).toEqual([
    'CHECK_AT_CHECKOUT',
    'CHECK_AT_CHECKOUT',
  ]);
  expect(events.filter((event) => event.event === 'card')).toHaveLength(2);
});

test('usual-item cards show the current price and can be added without an address', async () => {
  const deps = {
    orders: {
      purchaseSummary: async () => [{ variantId: 'variant', name: 'Milk', lastQuantity: 2 }],
    },
    catalog: { preview: async () => ({ items: [{ variantId: 'variant', sellingPaise: '3900' }] }) },
    appConfig: { get: async () => 10 },
  };
  const tool = createReadTools(
    deps as never,
    { userId: 'user', locale: 'en' },
    new AgentToolKit(5),
  ).find((item) => item.name === 'get_order_history_summary')! as unknown as TestTool;
  const events: unknown[] = [];
  const outcome = JSON.parse(
    await tool.invoke(
      { limit: 10 },
      { toolCallId: 'usual', writer: (event) => events.push(event) },
    ),
  );
  expect(outcome.ok).toBe(true);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'card',
        data: expect.objectContaining({
          payload: expect.objectContaining({
            items: [expect.objectContaining({ name: 'Milk', quantity: '2', sellingPaise: '3900' })],
            options: [
              expect.objectContaining({
                action: 'add_to_cart',
                payload: expect.objectContaining({
                  variantId: 'variant',
                  displayedUnitPricePaise: '3900',
                }),
              }),
            ],
          }),
        }),
      }),
    ]),
  );
});

test('address save rejects details the customer did not explicitly supply', async () => {
  const create = jest.fn(async () => ({
    address: { id: 'saved', point: null },
    needsConfirmation: false,
    degraded: false,
  }));
  const deps = { addresses: { create }, locationRequired: async () => false };
  const input = {
    line1: 'Railway Station Vijayawada',
    pincode: '520001',
    contactName: 'A Customer',
    contactPhone: '9876543210',
  };
  const make = (userText: string) =>
    createWriteTools(
      deps as never,
      { userId: 'user', threadId: 'thread', maxQuantity: 10, userText },
      new AgentToolKit(5),
    ).find((item) => item.name === 'save_address')! as unknown as TestTool;
  const denied = make(
    'Add the address Railway Station Vijayawada, pincode 520001, phone 9876543210',
  );
  const runtime = { toolCallId: 'save' };
  expect(JSON.parse(await denied.invoke(input, runtime)).error.code).toBe(
    'ADDRESS_SAVE_NOT_REQUESTED',
  );
  expect(create).not.toHaveBeenCalled();
  const allowed = make(
    'Add the address Railway Station Vijayawada, pincode 520001, phone 9876543210, name is A Customer',
  );
  expect(JSON.parse(await allowed.invoke(input, runtime))).toMatchObject({
    ok: true,
    data: { addressId: 'saved', locationConfirmed: false },
  });
  expect(create).toHaveBeenCalledTimes(1);
});
