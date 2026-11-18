import { assistantNotificationTarget } from '../src/agent/notification-target';

test('opens a reminder as an unsent suggestion rather than an order', () => {
  expect(assistantNotificationTarget({ link: '/agent', variantId: '10000000-0000-4000-8000-000000000001', productName: 'Milk' })).toEqual({ nudgeName: 'Milk' });
});

test('accepts only recognized links and valid conversation or item IDs', () => {
  const threadId = '10000000-0000-4000-8000-000000000002';
  expect(assistantNotificationTarget({ deepLink: '/agent', threadId })).toEqual({ threadId });
  expect(assistantNotificationTarget({ link: '/other', threadId })).toBeNull();
  expect(assistantNotificationTarget({ link: '/agent', variantId: 'not-a-uuid' })).toBeNull();
});
