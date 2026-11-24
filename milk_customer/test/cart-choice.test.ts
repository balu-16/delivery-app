import { cartChoiceAnsweredInMessage, cartChoiceExpiresAt, cartChoiceId, cartChoiceMessageText, cartChoiceQuestion, cartChoiceSubmitted, cartChoiceVariants, pendingCartChoiceKey, readPendingCartChoice } from '../src/agent/cart-choice';
import type { AgentCard, AgentMessage } from '../src/agent/types';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';

function card(payload: Record<string, unknown>): AgentCard {
  return { cardId: C1, type: 'cart_choice', payload };
}

test('reads variants from the direct list and skips out-of-stock ones', () => {
  const found = cartChoiceVariants(card({
    variants: [
      { variantId: V1, label: '500 g', sellingPaise: '5000' },
      { variantId: V2, label: '1 kg', availability: 'OUT_OF_STOCK' },
    ],
  }));
  expect(found).toEqual([{ variantId: V1, label: '500 g', sellingPaise: '5000' }]);
});

test('reads variants from options and items fallbacks', () => {
  expect(cartChoiceVariants(card({ options: [{ action: 'add_to_cart', payload: { variantId: V1 }, variantId: V1, label: '500 g' }] })))
    .toEqual([{ variantId: V1, label: '500 g' }]);
  expect(cartChoiceVariants(card({ items: [{ variantId: V2, variantName: '1 kg' }] })))
    .toEqual([{ variantId: V2, label: '1 kg' }]);
});

test('ignores malformed variants and dedupes repeats', () => {
  const found = cartChoiceVariants(card({
    variants: [null, { variantId: V1 }, { label: 'no id' }, { variantId: V1, label: '500 g' }, { variantId: V1, label: '500 g' }],
  }));
  expect(found).toEqual([{ variantId: V1, label: '500 g' }]);
});

test('expiry, choice id, question, and submitted status', () => {
  expect(cartChoiceExpiresAt(card({ expiresAt: 'not-a-date' }))).toBeNull();
  expect(cartChoiceExpiresAt(card({}))).toBeNull();
  expect(cartChoiceExpiresAt(card({ expiresAt: new Date(0).toISOString() }))).toBe(0);
  expect(cartChoiceId(card({ choiceId: 'c-1' }))).toBe('c-1');
  expect(cartChoiceId(card({}))).toBe(C1);
  expect(cartChoiceQuestion(card({ question: 'How many packs?' }))).toBe('How many packs?');
  expect(cartChoiceSubmitted(card({ status: 'committed' }))).toBe(true);
  expect(cartChoiceSubmitted(card({ status: 'pending' }))).toBe(false);
});

test('the card owns the quantity question in live and reopened messages', () => {
  const question = 'How many packs of Curd (400 g)?';
  const message: AgentMessage = { id: C1, role: 'assistant', text: question, cards: [card({ question, message: question })], createdAt: '' };
  expect(cartChoiceMessageText(message)).toBe('');
  expect(cartChoiceMessageText({ ...message, text: `Please review the current options. ${question}` }))
    .toBe('Please review the current options.');
  expect(cartChoiceMessageText({ ...message, text: 'Your cart was updated.' })).toBe('Your cart was updated.');
  const committed = card({ question, status: 'committed', selection: { variantId: V1, quantity: 1 } });
  expect(cartChoiceMessageText({ ...message, cards: [committed] })).toBe('');
  expect(cartChoiceAnsweredInMessage(committed)).toBe(false);
  expect(cartChoiceAnsweredInMessage(card({ ...committed.payload, selection: { variantId: V1, quantity: 1, answeredInMessage: true } }))).toBe(true);
});

test('round-trips a pending choice and rejects corrupt records', () => {
  const good = JSON.stringify({ cardId: C1, choiceId: 'c-1', variantId: V1, quantity: 2, actionId: V1 });
  expect(readPendingCartChoice(good)).toEqual({ cardId: C1, choiceId: 'c-1', variantId: V1, quantity: 2, actionId: V1 });
  expect(readPendingCartChoice('not-json')).toBeNull();
  expect(readPendingCartChoice(JSON.stringify({ cardId: C1, choiceId: 'c-1', variantId: V1, quantity: 0, actionId: V1 }))).toBeNull();
  expect(readPendingCartChoice(JSON.stringify({ cardId: C1, choiceId: 'c-1', variantId: V1, quantity: 2, actionId: 'x' }))).toBeNull();
  expect(pendingCartChoiceKey('abc')).toBe('@dairydirect/agent-cart-choice/abc');
});
