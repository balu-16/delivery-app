import {
  historySummary,
  parseAddressText,
} from '../../../src/modules/agent/infrastructure/read-tools.js';
import { policyText, POLICY_TOPICS } from '../../../src/modules/agent/infrastructure/policy.js';
import type { OrderView } from '../../../src/modules/orders/contracts/orders.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';

describe('order history summary', () => {
  const order = (
    id: string,
    placedAt: string,
    items: { variantId: string; name: string; orderedQty: string }[],
  ): OrderView =>
    ({
      orderId: id,
      items,
      status: 'DELIVERED',
      paymentStatus: 'PAID',
      totalPaise: '0',
      placedAt,
      orderNumber: id,
      userId: 'u',
      storeId: 's',
      onHold: false,
      paymentMethod: 'COD',
      subtotalPaise: '0',
      discountPaise: '0',
      feeTotalPaise: '0',
      taxTotalPaise: '0',
      tipPaise: '0',
      walletPromoPaise: '0',
      walletCashPaise: '0',
      amountDuePaise: '0',
      currency: 'INR',
      expiresAt: null,
      confirmedAt: null,
      deliveredAt: null,
      cancelReason: null,
      fees: [],
      metadata: {},
      version: '1',
    }) as unknown as OrderView;

  test('ranks variants by frequency then recency with the latest quantity', () => {
    const summary = historySummary([
      order('o1', '2026-11-01T01:00:00Z', [
        { variantId: 'milk', name: 'Toned Milk 500ml', orderedQty: '2' },
      ]),
      order('o2', '2026-11-03T01:00:00Z', [
        { variantId: 'milk', name: 'Toned Milk 500ml', orderedQty: '3' },
        { variantId: 'curd', name: 'Curd', orderedQty: '1' },
      ]),
      order('o3', '2026-11-05T01:00:00Z', [{ variantId: 'curd', name: 'Curd', orderedQty: '2' }]),
    ]);
    expect(summary.map((item) => item.variantId)).toEqual(['curd', 'milk']);
    expect(summary[0]).toMatchObject({
      orderCount: 2,
      lastQuantity: 2,
      lastOrderedAt: '2026-11-05T01:00:00Z',
    });
    expect(summary[1]).toMatchObject({
      orderCount: 2,
      lastQuantity: 3,
      lastOrderedAt: '2026-11-03T01:00:00Z',
    });
  });

  test('caps the summary at eight variants', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      order(`o${index}`, '2026-11-01T00:00:00Z', [
        { variantId: `v${index}`, name: `P${index}`, orderedQty: '1' },
      ]),
    );
    expect(historySummary(many)).toHaveLength(8);
  });
});

describe('typed address parsing', () => {
  test('extracts pincode, phone and landmark and reports the rest', () => {
    const parsed = parseAddressText(
      '2-21, Gandhinagar street, near bus stop, Vijayawada 520003, phone 9876543210',
      [],
    );
    expect(parsed).toMatchObject({
      pincode: '520003',
      contactPhone: '+919876543210',
      line1: '2-21',
    });
    expect(parsed.landmark?.toLowerCase()).toContain('bus stop');
    expect(parsed.missingFields).toEqual([]);
  });
  test('lists missing fields when pieces are absent', () => {
    const parsed = parseAddressText('Some street in Vijayawada', []);
    expect(parsed.pincode).toBeUndefined();
    expect(parsed.contactPhone).toBeUndefined();
    expect(parsed.missingFields).toContain('pincode');
    expect(parsed.missingFields).toContain('contact phone with country code');
  });
  test('detects a duplicate of an owned address without coordinates', () => {
    const saved = [
      {
        id: 'a1',
        line1: '2-21, Gandhinagar',
        line2: null,
        landmark: null,
        pincode: '520003',
        contactName: 'x',
        contactPhone: '+9198765432100',
        point: { lat: 16.3, lng: 80.4 },
        label: 'HOME',
        isDefault: true,
        version: '1',
      },
    ] as unknown as Parameters<typeof parseAddressText>[1];
    const parsed = parseAddressText('2-21, Gandhinagar, pincode 520003, +91 98765 43210', saved);
    expect(parsed.duplicateOfAddressId).toBe('a1');
  });
  test('never invents coordinates', () => {
    const parsed = parseAddressText(' somewhere near the big temple 500001 ', []);
    expect(parsed).not.toHaveProperty('point');
    expect(parsed).not.toHaveProperty('lat');
    expect(parsed).not.toHaveProperty('lng');
  });
});

describe('policy text', () => {
  const config = {
    get: async (key: string) => {
      const values: Record<string, unknown> = {
        deliveryFeeSlabs: [
          { maxOrderValuePaise: '30000', feePaise: '2500' },
          { maxOrderValuePaise: null, feePaise: '1500' },
        ],
        freeDeliveryThresholdPaise: '50000',
        handlingFeePaise: '500',
        smallCartThresholdPaise: '20000',
        smallCartFeePaise: '1000',
        surgeFeePaise: '0',
        minOrderPaise: '9900',
        etaMinMinutes: 30,
        etaMaxMinutes: 60,
        refundDestinationPolicy: 'original_then_wallet',
      };
      if (!(key in values)) throw new Error(`unexpected key ${key}`);
      return values[key];
    },
  } as unknown as AppConfig;

  test('delivery fees render configured amounts', async () => {
    const text = await policyText('delivery_fees', config);
    expect(text).toContain('₹25.00');
    expect(text).toContain('₹500.00');
    expect(text).toContain('No surge fee');
  });
  test('timings render the configured estimate range', async () => {
    expect(await policyText('timings', config)).toContain('30-60 minutes');
  });
  test('refund wording stays a request, never an approval', async () => {
    const text = await policyText('refunds', config);
    expect(text).toMatch(/review/i);
    expect(text).not.toMatch(/instant(ly)? (refund|approval)/i);
  });
  test('unavailable capabilities answer honestly', async () => {
    expect(await policyText('subscriptions', config)).toMatch(/not available/i);
    expect(await policyText('wallet', config)).toMatch(/cannot add money/i);
  });
  test('topics are a closed set', () => {
    expect(POLICY_TOPICS).toContain('delivery_fees');
    expect(POLICY_TOPICS).toHaveLength(7);
  });
});
