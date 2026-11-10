import { DisabledCallMasking } from '../../../src/adapters/call-masking/disabled.js';
import { canViewDeliveryContact } from '../../../src/modules/serviceability/contracts/contact.js';

it('keeps call masking disabled and limits contact access to the assigned rider during delivery', async () => {
  await expect(new DisabledCallMasking().createCall('customer', 'rider')).rejects.toThrow(
    'FEATURE_DISABLED',
  );
  expect(
    canViewDeliveryContact({
      requestingRiderId: 'rider',
      assignedRiderId: 'rider',
      taskStatus: 'PICKED_UP',
    }),
  ).toBe(true);
  expect(
    canViewDeliveryContact({
      requestingRiderId: 'other',
      assignedRiderId: 'rider',
      taskStatus: 'PICKED_UP',
    }),
  ).toBe(false);
  expect(
    canViewDeliveryContact({
      requestingRiderId: 'rider',
      assignedRiderId: 'rider',
      taskStatus: 'DELIVERED',
    }),
  ).toBe(false);
  expect(
    canViewDeliveryContact({
      requestingRiderId: 'rider',
      assignedRiderId: null,
      taskStatus: 'ASSIGNED',
    }),
  ).toBe(false);
});
