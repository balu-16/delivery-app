import { mapLine } from '../../../src/modules/cart/infrastructure/cart-evaluation.js';

// §3B listing: the cart line query reports available='0' for a withdrawn or
// missing store_inventory pair, so the line is unsaleable and evaluation
// produces the existing unavailable-item (ITEM_UNAVAILABLE) recovery path.
function row(available: string) {
  return {
    variant_id: 'variant-1',
    quantity: '2',
    unit_price_paise: '3500',
    mrp_paise: '4000',
    product_id: 'product-1',
    product_name: 'Milk',
    variant_name: '500 ml',
    image_id: null,
    category_id: 'cat-1',
    gst_rate_bps: 500,
    published: true,
    product_deleted: null,
    variant_deleted: null,
    fresh_price: '3500',
    fresh_mrp: '4000',
    price_id: 'price-1',
    available,
  };
}

describe('cart listing gate (§3B)', () => {
  it('a listed line with stock is saleable', () => {
    const line = mapLine(row('5'));
    expect(line.saleable).toBe(true);
    expect(line.available).toBe(5n);
  });
  it('a withdrawn line (available 0) is unsaleable without throwing', () => {
    const line = mapLine(row('0'));
    expect(line.saleable).toBe(false);
    expect(line.available).toBe(0n);
  });
});
