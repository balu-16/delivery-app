import { jest } from '@jest/globals';
import { CheckoutService } from '../../../src/modules/checkout/infrastructure/checkout-service.js';
import { fakeDatabase } from '../helpers/fake-db.js';

const QUOTE = {
  quoteId: 'q1',
  cartId: 'c1',
  cartVersion: 2,
  storeId: 's1',
  addressId: 'a1',
  amountDuePaise: '0',
};
const CART = { cartId: 'c1', version: 2 };

function checkout(walletRow: unknown) {
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes('customer_location_required'))
      return { rows: [{ required: false, present: true }] };
    if (query.sql.includes("key='wallet_enabled'")) return { rows: [walletRow] };
    return { rows: [] };
  });
  const refreshWithCart = jest.fn(async () => ({ quote: QUOTE, cart: CART }));
  const issue = jest.fn(async () => ({ intentId: 'i1', expiresAt: '2030-01-01T00:00:00.000Z' }));
  const configGet = jest.fn(async () => 10000);
  const deps = {
    quotes: { refreshWithCart },
    intents: { issue },
    config: { get: configGet },
  };
  const observeStage = jest.fn();
  const service = new CheckoutService(db, deps as never, {} as never, undefined, {
    observeStage,
  } as never);
  return { service, queries, refreshWithCart, configGet, observeStage };
}

test('returns the cart from the same quote evaluation and batches wallet reads', async () => {
  const { service, queries, refreshWithCart, observeStage } = checkout({
    enabled: true,
    cash: '100',
    promo: '50',
  });
  const result = await service.quote('u1', { addressId: 'a1' });
  expect(result.quote).toBe(QUOTE);
  expect(result.cart).toBe(CART);
  expect(result.intentId).toBe('i1');
  expect(refreshWithCart).toHaveBeenCalledTimes(1);
  expect(refreshWithCart).toHaveBeenCalledWith(
    expect.objectContaining({
      wallet: { promoAvailablePaise: '50', cashAvailablePaise: '100', promoSpendCapBps: 10000 },
    }),
  );
  // Address gate plus one batched wallet eligibility/balance read.
  expect(queries).toHaveLength(2);
  expect(observeStage).toHaveBeenCalledWith('checkout_quote', expect.any(Number));
  expect(observeStage).toHaveBeenCalledWith('checkout_quote_txn', expect.any(Number));
});

test('quotes without wallet when disabled and skips the spend-cap read', async () => {
  const { service, refreshWithCart, configGet } = checkout({
    enabled: false,
    cash: '100',
    promo: '50',
  });
  const result = await service.quote('u1', { addressId: 'a1' });
  expect(result.cart).toBe(CART);
  expect(refreshWithCart).toHaveBeenCalledWith(expect.objectContaining({ wallet: undefined }));
  expect(configGet).not.toHaveBeenCalled();
});
