import { DOMAIN_ERROR_STATUS } from '../../../src/common/http/problem-codes.js';
import { planForEvent } from '../../../src/modules/notifications/domain/matrix.js';
import { policyText } from '../../../src/modules/agent/infrastructure/policy.js';
import { subscriptionsRetired } from '../../../src/modules/subscriptions/retirement.js';
import { SubscriptionsService } from '../../../src/modules/subscriptions/infrastructure/subscriptions-service.js';

describe('subscription retirement (plan3 section 7)', () => {
  it('keeps the retirement guard enabled', () => {
    expect(subscriptionsRetired()).toBe(true);
  });

  it('maps SUBSCRIPTIONS_RETIRED to 410', () => {
    expect(DOMAIN_ERROR_STATUS.SUBSCRIPTIONS_RETIRED).toBe(410);
  });

  it('answers recurring-milk questions with one-time orders', async () => {
    const config = { get: async () => null } as never;
    await expect(policyText('subscriptions', config)).resolves.toBe(
      'DairyDirect offers one-time orders.',
    );
  });

  it('routes legacy recurring alert links to the inbox', () => {
    const user = '018f5e8a-9b8a-7c7d-8e8f-9a9b9c9d9e9f';
    for (const eventType of [
      'subscription.reminder',
      'subscription.low_balance',
      'subscription.price_increase',
      'subscription.skipped',
    ]) {
      const plan = planForEvent({
        eventType,
        aggregateId: user,
        aggregateVersion: '1',
        payload: { userId: user, subscriptionId: user, amountPaise: '100' },
      });
      expect(plan).not.toBeNull();
      expect(plan?.deepLink).toBeNull();
    }
  });

  it('returns empty compat reads without touching the database', async () => {
    const service = new SubscriptionsService(
      {} as never,
      { get: async () => '21:00' } as never,
      {} as never,
      {} as never,
    );
    await expect(service.list('u' as never)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(service.calendar('u' as never, '2040-05')).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      service.upcoming('u' as never, 'id' as never, '2040-05-01', '2040-05-31'),
    ).resolves.toEqual([]);
    await expect(() => service.get('u' as never, 'id' as never)).rejects.toThrow(
      'RESOURCE_NOT_FOUND',
    );
  });

  it('returns disabled purchase options in the existing shape', async () => {
    const service = new SubscriptionsService(
      {} as never,
      { get: async () => '21:00' } as never,
      {} as never,
      {} as never,
    );
    const options = await service.options('u' as never, 'a' as never, 'v' as never);
    expect(options.enabled).toBe(false);
    expect(options.eligible).toBe(false);
    expect(options.slots).toEqual([]);
    expect(options.firstStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects schedule-changing writes as retired', async () => {
    const service = new SubscriptionsService(
      {} as never,
      { get: async () => '21:00' } as never,
      {} as never,
      {} as never,
    );
    const input = {
      variantId: 'v',
      quantity: '1',
      frequencyRule: { type: 'DAILY' } as never,
      startDate: '2040-05-01',
      slotId: 's',
      addressId: 'a',
    } as never;
    await expect(() => service.create('u' as never, input)).rejects.toThrow(
      'SUBSCRIPTIONS_RETIRED',
    );
    await expect(() =>
      service.change('u' as never, 'id' as never, { quantity: '2' } as never),
    ).rejects.toThrow('SUBSCRIPTIONS_RETIRED');
    await expect(() =>
      service.pause('u' as never, 'id' as never, '2040-05-02', '2040-05-03'),
    ).rejects.toThrow('SUBSCRIPTIONS_RETIRED');
    await expect(() => service.resume('u' as never, 'id' as never)).rejects.toThrow(
      'SUBSCRIPTIONS_RETIRED',
    );
    await expect(() => service.skip('u' as never, 'id' as never, '2040-05-02')).rejects.toThrow(
      'SUBSCRIPTIONS_RETIRED',
    );
  });
});
