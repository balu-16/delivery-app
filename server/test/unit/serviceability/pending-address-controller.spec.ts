import { HttpException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { CustomerServiceabilityController } from '../../../src/surfaces/customer/serviceability/customer.controller.js';

test('requires a stable request key before saving a written address', async () => {
  const create = jest.fn(async () => ({
    address: { id: 'address', point: null },
    needsConfirmation: false,
    degraded: false,
  }));
  const controller = new CustomerServiceabilityController(
    { create } as never,
    {} as never,
    {} as never,
  );
  const principal = { userId: 'customer' } as never;
  const address = {
    line1: '1 Example Street',
    pincode: '520001',
    contactName: 'Customer',
    contactPhone: '+919876543210',
  };
  expect(() => controller.createPending(principal, address)).toThrow(HttpException);
  expect(() => controller.createPending(principal, address, 'invalid key')).toThrow(HttpException);
  expect(create).not.toHaveBeenCalled();
  await expect(controller.createPending(principal, address, 'request-1')).resolves.toMatchObject({
    address: { id: 'address', point: null },
  });
  expect(create).toHaveBeenCalledWith(
    'customer',
    { ...address, point: null },
    undefined,
    'request-1',
  );
});
