import 'reflect-metadata';
import { jest } from '@jest/globals';
import { CustomerServiceabilityController } from '../../../src/surfaces/customer/serviceability/customer.controller.js';

const FEES = {
  deliveryFeeSlabs: [
    { maxOrderValuePaise: '20000', feePaise: '4000' },
    { maxOrderValuePaise: null, feePaise: '2000' },
  ],
  freeDeliveryThresholdPaise: '59900',
  handlingFeePaise: '500',
  smallCartThresholdPaise: '19900',
  smallCartFeePaise: '1500',
  surgeFeePaise: '2500',
};

function controller(flags: Record<string, boolean>, fees: typeof FEES = FEES) {
  const getMany = jest.fn(async () => fees);
  const flag = jest.fn(async (key: string) => flags[key] ?? false);
  const config = { getMany, flag };
  return {
    controller: new CustomerServiceabilityController(
      {} as never,
      {} as never,
      {} as never,
      config as never,
    ),
    getMany,
    flag,
  };
}

test('keeps locationRequired and adds ordered decimal-string fee bands', async () => {
  const {
    controller: c,
    getMany,
    flag,
  } = controller({
    customer_location_required: true,
    surge_enabled: true,
  });
  const settings = await c.deliverySettings();
  expect(settings.locationRequired).toBe(true);
  expect(getMany).toHaveBeenCalledTimes(1);
  expect(getMany).toHaveBeenCalledWith([
    'deliveryFeeSlabs',
    'freeDeliveryThresholdPaise',
    'handlingFeePaise',
    'smallCartThresholdPaise',
    'smallCartFeePaise',
    'surgeFeePaise',
  ]);
  expect(flag).toHaveBeenCalledWith('customer_location_required');
  expect(flag).toHaveBeenCalledWith('surge_enabled');
  const estimate = settings.feeEstimate!;
  expect(typeof estimate.revision).toBe('string');
  expect(estimate.bands.map((band) => band.upToSubtotalPaise)).toEqual([
    '19900',
    '20000',
    '59900',
    null,
  ]);
  expect(estimate.bands[0]).toEqual({
    upToSubtotalPaise: '19900',
    deliveryPaise: '4000',
    handlingPaise: '500',
    smallCartPaise: '0',
    surgePaise: '2500',
  });
  expect(estimate.bands.at(-1)).toEqual({
    upToSubtotalPaise: null,
    deliveryPaise: '0',
    handlingPaise: '500',
    smallCartPaise: '0',
    surgePaise: '2500',
  });
  for (const band of estimate.bands)
    for (const amount of [
      band.deliveryPaise,
      band.handlingPaise,
      band.smallCartPaise,
      band.surgePaise,
    ])
      expect(amount).toMatch(/^(0|[1-9][0-9]*)$/);
});

test('drops surge and changes revision when the fee inputs change', async () => {
  const first = await controller({
    customer_location_required: false,
    surge_enabled: true,
  }).controller.deliverySettings();
  const second = await controller({
    customer_location_required: false,
    surge_enabled: false,
  }).controller.deliverySettings();
  expect(first.feeEstimate!.bands[0]!.surgePaise).toBe('2500');
  expect(second.feeEstimate!.bands[0]!.surgePaise).toBe('0');
  expect(first.feeEstimate!.revision).not.toBe(second.feeEstimate!.revision);
});

test('stays location-only when no admin config is provided', async () => {
  const c = new CustomerServiceabilityController({} as never, {} as never, {} as never);
  await expect(c.deliverySettings()).resolves.toEqual({ locationRequired: true });
});
