import type { QuoteIssue } from '../contracts/quote.js';
import type { CartView } from '../contracts/cart.js';
import type { CartRow, EvaluatedLine } from './cart-evaluation.js';
export function toCartView(cart: CartRow, lines: EvaluatedLine[], issues: QuoteIssue[]): CartView {
  return {
    cartId: cart.id,
    userId: cart.user_id,
    storeId: cart.store_id,
    addressId: cart.address_id,
    version: Number(cart.version),
    couponCode: cart.coupon_code,
    lines: lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity.toString(),
      unitPricePaise: line.storedUnitPricePaise.toString(),
      mrpPaise: line.mrpPaise.toString(),
      lineSubtotalPaise: (line.storedUnitPricePaise * line.quantity).toString(),
    })),
    issues,
  };
}
