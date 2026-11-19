/// <reference types="jest" />
import { WELCOMES, welcomeFor } from '../src/agent/welcome';
import { agentStrings } from '../src/agent/strings';
import { FLY_TO_CART_MS, MAX_FLY_TO_CART } from '../components/animations/FlyToCart';

test('four fixed welcomes, rotated per thread and stable for one chat', () => {
  expect(WELCOMES).toEqual([
    'Hi, I’m your DairyDirect assistant. How can I help?',
    'Hello! I can help with your cart and orders.',
    'Welcome! What would you like to shop for today?',
    'Hey! I can help you find products or track a delivery.',
  ]);
  expect(welcomeFor()).toBe(WELCOMES[0]);
  expect(welcomeFor('one')).toBe(welcomeFor('one'));
  expect(WELCOMES).toContain(welcomeFor('some-thread-id'));
});

test('assistant strings carry the branded opening and choice states', () => {
  const t = agentStrings('en');
  expect(t.opening).toBe('Opening your chat…');
  expect(t.activityChoice).toBe('Waiting for your choice');
  expect(t.activityProducts).toBe('Finding products…');
});

test('cart flight timing and concurrency cap', () => {
  expect(FLY_TO_CART_MS).toBe(800);
  expect(MAX_FLY_TO_CART).toBe(3);
});
