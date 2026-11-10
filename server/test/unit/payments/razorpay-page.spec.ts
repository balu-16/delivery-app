import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('test checkout uses server amounts, verifies the callback and waits for paid status', async () => {
  const handlers = new Map<string, () => Promise<void>>();
  const elements: Record<
    string,
    {
      value: string;
      disabled: boolean;
      textContent: string;
      addEventListener: (event: string, handler: () => Promise<void>) => void;
    }
  > = {};
  for (const name of ['token', 'address', 'pay', 'check', 'status'])
    elements[name] = {
      value: '',
      disabled: false,
      textContent: '',
      addEventListener: (_event, handler) => handlers.set(name, handler),
    };
  elements.token!.value = 'customer-token';
  elements.address!.value = 'address-id';
  const calls: Array<{ url: string; options: { body?: string } }> = [];
  const fetch = async (url: string, options: { body?: string }) => {
    calls.push({ url, options });
    let body: unknown;
    if (url.endsWith('/checkout/quote'))
      body = { quote: { quoteId: 'quote-id' }, intentId: 'intent-id' };
    else if (url.endsWith('/checkout/place'))
      body = {
        order: { orderId: 'app-order' },
        payment: {
          attemptId: 'attempt-id',
          gatewayOrderId: 'order-gateway',
          amountDuePaise: '125',
          currency: 'INR',
          provider: 'razorpay',
          publicKeyId: 'rzp_test_public',
        },
      };
    else if (url.endsWith('/verify')) body = {};
    else
      body = {
        order: { paymentStatus: 'PAID' },
        attempts: [{ attemptId: 'attempt-id', status: 'CAPTURED' }],
      };
    return { ok: true, json: async () => body };
  };
  let checkoutOptions:
    { amount: number; order_id: string; handler: (result: object) => Promise<void> } | undefined;
  class Checkout {
    constructor(options: typeof checkoutOptions) {
      checkoutOptions = options;
    }
    on() {}
    open() {}
  }
  const source = readFileSync(
    new URL('../../../devtools/razorpay-checkout/checkout.js', import.meta.url),
    'utf8',
  );
  runInNewContext(source, {
    document: { querySelector: (selector: string) => elements[selector.slice(1)] },
    window: { Razorpay: Checkout },
    fetch,
    crypto: { randomUUID: () => 'idem-key' },
    setTimeout,
    console,
  });
  await handlers.get('pay')!();
  expect(checkoutOptions?.amount).toBe(125);
  expect(checkoutOptions?.order_id).toBe('order-gateway');
  expect(
    JSON.parse(calls.find((call) => call.url.endsWith('/checkout/place'))!.options.body!),
  ).toEqual({ quoteId: 'quote-id', intentId: 'intent-id', method: 'GATEWAY' });
  await checkoutOptions!.handler({
    razorpay_order_id: 'order-gateway',
    razorpay_payment_id: 'pay-gateway',
    razorpay_signature: 'signature',
  });
  expect(JSON.parse(calls.find((call) => call.url.endsWith('/verify'))!.options.body!)).toEqual({
    attemptId: 'attempt-id',
    gatewayOrderId: 'order-gateway',
    gatewayPaymentId: 'pay-gateway',
    signature: 'signature',
  });
  expect(elements.status!.textContent).toBe('Payment captured and order paid.');
  expect(elements.pay!.disabled).toBe(true);
});

test('closing the gateway modal preserves the pending order and permits a retry', async () => {
  const handlers = new Map<string, () => Promise<void>>();
  const elements: Record<
    string,
    {
      value: string;
      disabled: boolean;
      textContent: string;
      addEventListener: (event: string, handler: () => Promise<void>) => void;
    }
  > = {};
  for (const name of ['token', 'address', 'pay', 'check', 'status'])
    elements[name] = {
      value: '',
      disabled: false,
      textContent: '',
      addEventListener: (_event, handler) => handlers.set(name, handler),
    };
  elements.token!.value = 'customer-token';
  elements.address!.value = 'address-id';
  let orderRequests = 0;
  const fetch = async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.endsWith('/checkout/quote'))
        return { quote: { quoteId: 'quote-id' }, intentId: 'intent-id' };
      orderRequests++;
      return {
        order: { orderId: 'app-order' },
        payment: {
          attemptId: 'attempt-id',
          gatewayOrderId: 'order-gateway',
          amountDuePaise: '100',
          currency: 'INR',
          provider: 'razorpay',
          publicKeyId: 'rzp_test_public',
        },
      };
    },
  });
  let close: (() => void) | undefined;
  class Checkout {
    constructor(options: { modal: { ondismiss: () => void } }) {
      close = options.modal.ondismiss;
    }
    on() {}
    open() {}
  }
  const source = readFileSync(
    new URL('../../../devtools/razorpay-checkout/checkout.js', import.meta.url),
    'utf8',
  );
  runInNewContext(source, {
    document: { querySelector: (selector: string) => elements[selector.slice(1)] },
    window: { Razorpay: Checkout },
    fetch,
    crypto: { randomUUID: () => 'idem-key' },
    setTimeout,
  });
  await handlers.get('pay')!();
  close!();
  expect(elements.status!.textContent).toContain('pending');
  expect(elements.pay!.disabled).toBe(false);
  await handlers.get('pay')!();
  expect(orderRequests).toBe(1);
});
