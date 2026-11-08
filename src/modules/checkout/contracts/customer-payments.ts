import type { CheckoutPaymentView } from './checkout.js';
import type { PaymentIntent } from '../../payments/contracts/payments.js';
import type { OrderView } from '../../orders/contracts/orders.js';
export const CHECKOUT_PAYMENTS = Symbol('CHECKOUT_PAYMENTS');
export interface CustomerPayments {
  retry(userId: string, orderId: string, key: string): Promise<CheckoutPaymentView | null>;
  verify(
    userId: string,
    orderId: string,
    input: {
      attemptId: string;
      gatewayOrderId: string;
      gatewayPaymentId: string;
      signature: string;
    },
  ): Promise<{ order: OrderView; attempt: PaymentIntent }>;
  status(
    userId: string,
    orderId: string,
  ): Promise<{ order: OrderView; attempts: readonly PaymentIntent[] }>;
}
