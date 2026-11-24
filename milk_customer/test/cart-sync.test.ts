/// <reference types="jest" />
import { undoCartOperation, type CartOperation } from '../src/store/cart-sync';

let opCounter = 0;
const op = ({ variantId, ...over }: Partial<CartOperation> & { variantId: string }): CartOperation => ({
  id: `id-${variantId}-${++opCounter}`,
  variantId,
  delta: 1,
  ...over,
});

test('undo removes one unit from the most recent unsent tap', () => {
  const actions = [op({ variantId: 'a', delta: 1 }), op({ variantId: 'a', delta: 3 })];
  const undone = undoCartOperation(actions, 'a');
  expect(undone).toHaveLength(2);
  expect(undone![1].delta).toBe(2);
  expect(actions[1].delta).toBe(3);
});

test('undo drops an op that reaches zero and price-accept ops entirely', () => {
  expect(undoCartOperation([op({ variantId: 'a', delta: 1 })], 'a')).toEqual([]);
  expect(undoCartOperation([op({ variantId: 'a', delta: -1 })], 'a')).toEqual([]);
  expect(undoCartOperation([op({ variantId: 'a', delta: 0, acceptedPricePaise: '100' })], 'a')).toEqual([]);
});

test('undo never touches sent or uncertain operations', () => {
  const sent = op({ variantId: 'a', delta: 2, request: { quantity: '3', version: 2 } });
  expect(undoCartOperation([sent], 'a')).toBeNull();
  const mixed = [sent, op({ variantId: 'a', delta: 1 })];
  const undone = undoCartOperation(mixed, 'a');
  expect(undone).toHaveLength(1);
  expect(undone![0]).toBe(sent);
});

test('undo only affects the requested variant and reports nothing undoable', () => {
  const actions = [op({ variantId: 'a', delta: 2 }), op({ variantId: 'b', delta: 1 })];
  expect(undoCartOperation(actions, 'missing')).toBeNull();
  const undone = undoCartOperation(actions, 'b');
  expect(undone).toHaveLength(1);
  expect(undone![0].variantId).toBe('a');
  expect(undone![0].delta).toBe(2);
});
