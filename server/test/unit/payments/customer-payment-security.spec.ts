import { jest } from '@jest/globals';
import { CustomerPaymentService } from '../../../src/modules/checkout/infrastructure/customer-payments.js';
import type { Database } from '../../../src/platform/database/database.js';
import type { OrderOperations } from '../../../src/modules/orders/contracts/orders.js';
import type {
  PaymentOrderOperations,
  PaymentVerification,
} from '../../../src/modules/payments/contracts/payments.js';
import type { PaymentGatewayPort } from '../../../src/modules/payments/contracts/gateway.js';
import type { CheckoutOperations } from '../../../src/modules/checkout/contracts/checkout.js';

function setup(valid = true) {
  const attempt = {
    attemptId: 'attempt',
    gatewayOrderId: 'order_from_database',
    status: 'CREATED',
  };
  const order = { orderId: 'app-order' };
  const signature = jest.fn<() => boolean>().mockReturnValue(valid);
  const poll = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const service = new CustomerPaymentService(
    {} as Database,
    {
      byId: async (_id: string, input: { userId: string }) =>
        input.userId === 'owner' ? order : null,
    } as unknown as OrderOperations,
    { listAttempts: async () => [attempt] } as unknown as PaymentOrderOperations,
    { verifyCheckoutSignature: signature } as unknown as PaymentGatewayPort,
    { pollAttempt: poll } as unknown as PaymentVerification,
    {} as CheckoutOperations,
  );
  return { service, signature, poll };
}
const payment = {
  attemptId: 'attempt',
  gatewayOrderId: 'order_from_database',
  gatewayPaymentId: 'pay_test',
  signature: 'signature',
};

test('verifies a customer payment using the stored gateway order and polls for capture', async () => {
  const { service, signature, poll } = setup();
  await service.verify('owner', 'app-order', payment);
  expect(signature).toHaveBeenCalledWith({ ...payment, gatewayOrderId: 'order_from_database' });
  expect(poll).toHaveBeenCalledWith('attempt', 'pay_test');
});

test('rejects foreign orders, mismatched gateway orders and invalid signatures before polling', async () => {
  const { service, signature, poll } = setup(false);
  await expect(service.verify('other', 'app-order', payment)).rejects.toThrow('ORDER_NOT_FOUND');
  await expect(
    service.verify('owner', 'app-order', { ...payment, gatewayOrderId: 'forged' }),
  ).rejects.toThrow('PAYMENT_FUNDING_INVALID');
  expect(signature).not.toHaveBeenCalled();
  await expect(service.verify('owner', 'app-order', payment)).rejects.toThrow(
    'PAYMENT_SIGNATURE_INVALID',
  );
  expect(poll).not.toHaveBeenCalled();
});
