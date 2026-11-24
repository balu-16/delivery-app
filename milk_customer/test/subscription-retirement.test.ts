/// <reference types="jest" />
// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';

test('customer app exposes no recurring subscription UI surface', () => {
  const root = path.join(__dirname, '..');
  const myDairy = fs.readFileSync(path.join(root, 'app/(tabs)/my-dairy.tsx'), 'utf8');
  expect(myDairy).not.toContain('Subscription');
  expect(myDairy.toLowerCase()).not.toContain('subscription');
  const store = fs.readFileSync(path.join(root, 'src/store/customer.ts'), 'utf8');
  expect(store).not.toContain('createSubscription');
  expect(store).not.toContain('pendingSubscription');
  const api = fs.readFileSync(path.join(root, 'src/api/customer.ts'), 'utf8');
  expect(api).not.toContain('CustomerSubscription');
  expect(api).not.toContain('SubscriptionOptions');
  expect(api).not.toContain('createSubscription');
  expect(fs.existsSync(path.join(root, 'components/connected/SubscriptionPanel.tsx'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'components/connected/SubscriptionManagement.tsx'))).toBe(false);
});
