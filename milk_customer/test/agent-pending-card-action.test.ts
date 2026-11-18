import { readPendingCardAction } from '../src/agent/pending-card-action';

const id = '018f0000-0000-7000-8000-000000000001';
const action = { cardId: id, action: 'add_to_cart', id, payload: JSON.stringify({ variantId: id, addressId: id, quantity: 2 }) };

test('restores the same action ID and quantity after an interrupted cart update', () => {
  expect(readPendingCardAction(JSON.stringify(action))).toEqual(action);
});

test('does not silently accept incomplete or malformed pending actions', () => {
  expect(readPendingCardAction('{')).toBeNull();
  expect(readPendingCardAction(JSON.stringify({ ...action, id: 'not-a-uuid' }))).toBeNull();
  expect(readPendingCardAction(JSON.stringify({ ...action, payload: JSON.stringify({ variantId: id, addressId: id, quantity: -1 }) }))).toBeNull();
});
