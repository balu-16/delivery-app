import {
  matchCannedIntent,
  normalizeIntentText,
  rotatingReplyKey,
  trackingStatusLine,
} from '../../../src/modules/agent/infrastructure/canned.js';
import {
  titleForRequest,
  verifiedProductInText,
} from '../../../src/modules/agent/infrastructure/titles.js';
import { parseChoiceAnswer } from '../../../src/modules/agent/infrastructure/choices.js';

test('normalizes intent text', () => {
  expect(normalizeIntentText('  Héllo!! ')).toBe('hello');
  expect(normalizeIntentText('Butter-milk?')).toBe('butter milk');
});

test('routes shopping to the model even after a greeting', () => {
  expect(matchCannedIntent('Hi, add curd to my cart')).toBe('model');
  expect(matchCannedIntent('hello, add 2 packs of 500 g curd')).toBe('model');
  expect(matchCannedIntent('Order them')).toBe('model');
  expect(matchCannedIntent('I want paneer')).toBe('model');
});

test('matches standalone greetings and thanks', () => {
  expect(matchCannedIntent('Hi')).toBe('greeting');
  expect(matchCannedIntent('hello!')).toBe('greeting');
  expect(matchCannedIntent('Good morning')).toBe('greeting');
  expect(matchCannedIntent('thanks!')).toBe('thanks');
  expect(matchCannedIntent('Thank you so much')).toBe('thanks');
});

test('thanks with shopping still goes to the model', () => {
  expect(matchCannedIntent('thanks, now add milk')).toBe('model');
});

test('matches FAQs and help, not actions', () => {
  expect(matchCannedIntent('where is my cart?')).toBe('faq_cart');
  expect(matchCannedIntent('how do I change my delivery address?')).toBe('model');
  expect(matchCannedIntent('which pincode do you deliver to?')).toBe('faq_address');
  expect(matchCannedIntent('track my order')).toBe('faq_tracking');
  expect(matchCannedIntent('where is my delivery?')).toBe('faq_tracking');
  expect(matchCannedIntent('I want to talk to a human')).toBe('faq_support');
  expect(matchCannedIntent('what can you do?')).toBe('help');
  expect(matchCannedIntent('cancel my order')).toBe('model');
  expect(matchCannedIntent('I want a refund')).toBe('model');
});

test('rotates greeting and thanks variants deterministically', () => {
  expect([0, 1, 2, 3, 4].map((n) => rotatingReplyKey('greeting', n))).toEqual([
    'greeting_1',
    'greeting_2',
    'greeting_3',
    'greeting_4',
    'greeting_1',
  ]);
  expect(rotatingReplyKey('thanks', 2)).toBe('thanks_3');
});

test('composes tracking lines from order data only', () => {
  expect(trackingStatusLine(null)).toBe('You have no orders yet.');
  expect(trackingStatusLine({ orderNumber: 'ORD-1', status: 'OUT_FOR_DELIVERY' })).toBe(
    'Your latest order ORD-1 is out for delivery.',
  );
});

test('titles chats without copying customer text', () => {
  expect(titleForRequest('greeting', null)).toBe('New chat');
  expect(titleForRequest('faq_tracking', null)).toBe('Track an order');
  expect(titleForRequest('model', 'Curd')).toBe('Curd for your cart');
  expect(titleForRequest('model', null)).toBe('Shopping help');
  expect(titleForRequest('faq_cart', null)).toBe('Shopping help');
});

test('verifies product names against the catalog list', () => {
  const names = [
    { key: 'Curd', display: 'Curd' },
    { key: 'Buttermilk', display: 'Buttermilk' },
  ];
  expect(verifiedProductInText('add butter milk to my cart', names)).toBe('Buttermilk');
  expect(verifiedProductInText('add 2 curd', names)).toBe('Curd');
  expect(verifiedProductInText('track my order', names)).toBe(null);
  expect(verifiedProductInText('add dragonfruit', names)).toBe(null);
});

const variants = [
  { variantId: '11111111-1111-1111-1111-111111111111', label: '500 g' },
  { variantId: '22222222-2222-2222-2222-222222222222', label: '1 kg' },
];

test('parses typed choice answers', () => {
  expect(parseChoiceAnswer('2 packs of 500 g', variants)).toEqual({
    variantId: '11111111-1111-1111-1111-111111111111',
    quantity: 2,
  });
  expect(parseChoiceAnswer('two of the 1 kg please', variants)).toEqual({
    variantId: '22222222-2222-2222-2222-222222222222',
    quantity: 2,
  });
  expect(parseChoiceAnswer('the second one, 3 packs', variants)).toEqual({
    variantId: '22222222-2222-2222-2222-222222222222',
    quantity: 3,
  });
});

test('implies the only variant but still requires a quantity', () => {
  const single = [variants[0]!];
  expect(parseChoiceAnswer('2 packs', single)).toEqual({
    variantId: '11111111-1111-1111-1111-111111111111',
    quantity: 2,
  });
  expect(parseChoiceAnswer('500 g', single)).toEqual({
    variantId: '11111111-1111-1111-1111-111111111111',
    quantity: null,
    partial: true,
  });
});

test('returns null when the text carries no answer', () => {
  expect(parseChoiceAnswer('never mind', variants)).toBe(null);
  expect(parseChoiceAnswer('track my order', variants)).toBe(null);
  expect(parseChoiceAnswer('', variants)).toBe(null);
  expect(parseChoiceAnswer('never mind', [variants[0]!])).toBe(null);
});

test('an order action or ambiguous number does not confirm a pending cart choice', () => {
  const single = [variants[0]!];
  for (const message of ['Cancel order 2', 'Add 2 packs of butter', '-2', '2.5 packs', '2 or 3']) {
    expect(parseChoiceAnswer(message, single)).toBeNull();
  }
  expect(parseChoiceAnswer('option 2', variants)).toEqual({
    variantId: variants[1]!.variantId,
    quantity: null,
    partial: true,
  });
});
