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

test('parallel product searches emit only one address prompt', async () => {
  const deps = { addresses: { list: async () => [] }, cart: { get: async () => null } };
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
  expect(outcomes.map((result) => JSON.parse(result).error.code)).toEqual([
    'ADDRESS_REQUIRED',
    'ADDRESS_REQUIRED',
  ]);
  expect(events.filter((event) => event.event === 'card')).toHaveLength(1);
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
