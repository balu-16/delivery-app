/* global document, fetch, window, crypto, setTimeout */
'use strict';
const token = document.querySelector('#token');
const address = document.querySelector('#address');
const pay = document.querySelector('#pay');
const check = document.querySelector('#check');
const status = document.querySelector('#status');
const api = 'http://localhost:3000';
let current = null;
let pendingPlacement = null;
let completed = false;
let retryKey = null;
function show(message) {
  status.textContent = message;
}
async function request(path, method = 'GET', body, key) {
  const response = await fetch(api + path, {
    method,
    headers: {
      authorization: `Bearer ${token.value.trim()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`Request failed (${response.status}): ${data.code || 'Please try again'}`);
  return data;
}
async function refresh() {
  const result = await request(`/v1/customer/payments/${current.orderId}`);
  const captured = result.attempts?.some(
    (attempt) => attempt.attemptId === current.payment.attemptId && attempt.status === 'CAPTURED',
  );
  if (captured && result.order?.paymentStatus === 'PAID') {
    completed = true;
    show('Payment captured and order paid.');
    return;
  }
  show('Payment verification is pending. Check the order status before retrying.');
}
check.addEventListener('click', async () => {
  check.disabled = true;
  try {
    await refresh();
  } catch (error) {
    show(error.message || 'Could not check the order.');
  } finally {
    check.disabled = !current;
  }
});
pay.addEventListener('click', async () => {
  pay.disabled = true;
  try {
    if (!token.value.trim() || !address.value.trim())
      throw new Error('Enter the customer token and address ID.');
    if (!window.Razorpay) throw new Error('Razorpay Checkout could not be loaded.');
    if (!current) {
      show('Creating a checkout quote…');
      if (!pendingPlacement) {
        const quote = await request('/v1/customer/checkout/quote', 'POST', {
          addressId: address.value.trim(),
        });
        pendingPlacement = {
          body: { quoteId: quote.quote.quoteId, intentId: quote.intentId, method: 'GATEWAY' },
          key: crypto.randomUUID(),
        };
      }
      const result = await request(
        '/v1/customer/checkout/place',
        'POST',
        pendingPlacement.body,
        pendingPlacement.key,
      );
      if (!result.payment) {
        completed = true;
        show(`Order ${result.confirmation}. No gateway payment is due.`);
        return;
      }
      current = { orderId: result.order.orderId, payment: result.payment };
      check.disabled = false;
    }
    if (!current.payment.gatewayOrderId) {
      retryKey ||= crypto.randomUUID();
      const retry = await request(
        `/v1/customer/payments/${current.orderId}/retry`,
        'POST',
        undefined,
        retryKey,
      );
      if (retry) current.payment = retry;
    }
    const p = current.payment;
    if (p.provider !== 'razorpay' || !p.publicKeyId || !p.gatewayOrderId)
      throw new Error('Gateway order is not ready. Check order status before retrying.');
    const amount = Number(p.amountDuePaise);
    if (!Number.isSafeInteger(amount) || amount < 100) throw new Error('Invalid gateway amount.');
    let success = false;
    const checkout = new window.Razorpay({
      key: p.publicKeyId,
      amount,
      currency: p.currency,
      order_id: p.gatewayOrderId,
      name: 'Delivery test checkout',
      handler: async (response) => {
        success = true;
        try {
          show('Verifying payment…');
          await request(`/v1/customer/payments/${current.orderId}/verify`, 'POST', {
            attemptId: p.attemptId,
            gatewayOrderId: response.razorpay_order_id,
            gatewayPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          });
          for (let i = 0; i < 12 && !completed; i++) {
            await refresh();
            if (!completed) await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (error) {
          show(
            (error.message || 'Payment verification failed.') +
              ' Check the order status before retrying.',
          );
        } finally {
          pay.disabled = true;
        }
      },
      modal: {
        ondismiss: () => {
          if (!success) {
            show('Checkout closed. Your order remains pending; you may retry.');
            pay.disabled = false;
          }
        },
      },
    });
    checkout.on('payment.failed', () => {
      show('Payment failed. Check the payment status before retrying.');
    });
    checkout.open();
  } catch (error) {
    show(error.message || 'Checkout could not be started.');
    pay.disabled = false;
  }
});
