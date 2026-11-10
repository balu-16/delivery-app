/**
 * Pure pricing engine over integer paise. GST-inclusive prices: tax is extracted
 * for disclosure after discount allocation and is never added again (D14).
 * Deterministic: same input always yields the same totals and allocations.
 */
export interface PricingLineInput {
  variantId: string;
  quantity: bigint;
  unitPricePaise: bigint;
  mrpPaise: bigint;
  taxRateBps: number;
  eligibleForDiscount: boolean;
}
export interface PricingCouponInput {
  kind: 'PERCENT' | 'FLAT' | 'FREE_DELIVERY';
  value: bigint;
  maxCapPaise: bigint | null;
}
export interface PricingFeeConfig {
  deliveryFeeSlabs: { maxOrderValuePaise: bigint | null; feePaise: bigint }[];
  freeDeliveryThresholdPaise: bigint;
  handlingFeePaise: bigint;
  smallCartThresholdPaise: bigint;
  smallCartFeePaise: bigint;
  surgeFeePaise: bigint;
  surgeEnabled: boolean;
  feeTaxRules: {
    appliesTo: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE' | 'ALL';
    taxBps: number;
    split: 'CGST_SGST' | 'IGST';
  }[];
}
export interface PricingLineResult {
  variantId: string;
  quantity: bigint;
  unitPricePaise: bigint;
  mrpPaise: bigint;
  lineSubtotalPaise: bigint;
  discountPaise: bigint;
  taxRateBps: number;
  taxPaise: bigint;
  lineTotalPaise: bigint;
}
export interface PricingFeeResult {
  kind: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE' | 'TIP';
  amountPaise: bigint;
  taxPaise: bigint;
  taxSplit: 'CGST_SGST' | 'IGST' | null;
}
export interface PricingTotals {
  lines: PricingLineResult[];
  fees: PricingFeeResult[];
  couponDiscountPaise: bigint;
  subtotalPaise: bigint;
  discountPaise: bigint;
  feeTotalPaise: bigint;
  taxTotalPaise: bigint;
  tipPaise: bigint;
  totalPaise: bigint;
  wallet: { promoPaise: bigint; cashPaise: bigint } | null;
  amountDuePaise: bigint;
  minOrderNotMet: boolean;
  maxOrderExceeded: boolean;
  deliveryFeeWaived: boolean;
}

function money(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`INVALID_MONEY:${label}`);
  return value;
}
/** round_half_up(numerator/denominator) for non-negative integers, exact in BigInt. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('INVALID_MONEY:denominator');
  return (2n * numerator + denominator) / (2n * denominator);
}

/** Largest-remainder allocation of `total` paise pro-rata over the weights. */
export function allocateProRata(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n || total <= 0n) return weights.map(() => 0n);
  const floors = weights.map((weight) => (total * weight) / sum);
  let remainder = total - floors.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((weight, index) => ({
      index,
      fraction: total * weight - floors[index]! * sum,
      weight,
    }))
    .sort(
      (a, b) =>
        (a.fraction > b.fraction ? -1 : a.fraction < b.fraction ? 1 : 0) ||
        (a.weight > b.weight ? -1 : a.weight < b.weight ? 1 : 0) ||
        a.index - b.index,
    );
  const result = [...floors];
  for (const entry of order) {
    if (remainder <= 0n) break;
    result[entry.index] = result[entry.index]! + 1n;
    remainder -= 1n;
  }
  return result;
}

function couponDiscount(subtotal: bigint, coupon: PricingCouponInput): bigint {
  const cap = coupon.maxCapPaise === null ? null : money(coupon.maxCapPaise, 'maxCapPaise');
  if (coupon.kind === 'PERCENT') {
    const value = money(coupon.value, 'value');
    if (value > 10000n) throw new Error('INVALID_QUOTE_REQUEST:percent');
    const raw = roundHalfUp(subtotal * value, 10000n);
    const capped = cap !== null && raw > cap ? cap : raw;
    return capped > subtotal ? subtotal : capped;
  }
  if (coupon.kind === 'FLAT') {
    const value = money(coupon.value, 'value');
    const capped = cap !== null && value > cap ? cap : value;
    return capped > subtotal ? subtotal : capped;
  }
  return 0n; // FREE_DELIVERY waives the delivery fee instead of line discounts.
}

function feeTax(
  kind: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE',
  amount: bigint,
  rules: PricingFeeConfig['feeTaxRules'],
): { taxPaise: bigint; taxSplit: 'CGST_SGST' | 'IGST' | null } {
  const matches = rules.filter((rule) => rule.appliesTo === kind || rule.appliesTo === 'ALL');
  const rule = [...matches].reverse().find((entry) => entry.appliesTo === kind) ?? matches.at(-1);
  if (!rule || amount <= 0n) return { taxPaise: 0n, taxSplit: null };
  return {
    taxPaise: roundHalfUp(amount * BigInt(rule.taxBps), 10000n + BigInt(rule.taxBps)),
    taxSplit: rule.split,
  };
}

/** Slab fees key on post-discount merchandise value; the open-ended slab must be last. */
export function deliveryFee(merchandise: bigint, config: PricingFeeConfig): bigint {
  let previous: bigint | null = null;
  for (const slab of config.deliveryFeeSlabs) {
    const ceiling =
      slab.maxOrderValuePaise === null ? null : money(slab.maxOrderValuePaise, 'slab');
    const fee = money(slab.feePaise, 'slabFee');
    if (ceiling !== null && previous !== null && ceiling <= previous)
      throw new Error('INVALID_QUOTE_REQUEST:slabs');
    previous = ceiling;
    if (ceiling === null || merchandise <= ceiling) return fee;
  }
  throw new Error('INVALID_QUOTE_REQUEST:slabs');
}

/**
 * Pipeline: line subtotals → coupon allocation (largest remainder) → fees on
 * post-discount merchandise → inclusive-tax extraction → tip → total → wallet.
 * Totals include tax by construction; every amount is a non-negative paise count.
 */
export function computeQuote(input: {
  lines: PricingLineInput[];
  coupon: PricingCouponInput | null;
  tipPaise: bigint;
  fees: PricingFeeConfig;
  wallet: {
    promoAvailablePaise: bigint;
    cashAvailablePaise: bigint;
    promoSpendCapBps: number;
  } | null;
  minOrderPaise: bigint;
  maxOrderPaise: bigint;
}): PricingTotals {
  const tip = money(input.tipPaise, 'tip');
  const minOrder = money(input.minOrderPaise, 'minOrder');
  const maxOrder = money(input.maxOrderPaise, 'maxOrder');
  if (!Array.isArray(input.lines) || input.lines.length > 1000)
    throw new Error('INVALID_QUOTE_REQUEST:lines');
  if (input.wallet) {
    money(input.wallet.promoAvailablePaise, 'promo');
    money(input.wallet.cashAvailablePaise, 'cash');
    if (!Number.isSafeInteger(input.wallet.promoSpendCapBps) || input.wallet.promoSpendCapBps < 0)
      throw new Error('INVALID_QUOTE_REQUEST:cap');
  }
  const lines = [...input.lines]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map((line) => ({
      ...line,
      quantity: money(line.quantity, 'quantity'),
      unitPricePaise: money(line.unitPricePaise, 'unitPrice'),
      mrpPaise: money(line.mrpPaise, 'mrp'),
      lineSubtotalPaise: money(line.quantity, 'quantity') * money(line.unitPricePaise, 'unitPrice'),
    }));
  if (lines.some((line) => line.lineSubtotalPaise > 0n && line.unitPricePaise > line.mrpPaise))
    throw new Error('INVALID_QUOTE_REQUEST:mrp');
  const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotalPaise, 0n);
  const eligibleSubtotal = lines
    .filter((line) => line.eligibleForDiscount)
    .reduce((sum, line) => sum + line.lineSubtotalPaise, 0n);
  const rawCouponDiscount =
    input.coupon && eligibleSubtotal > 0n ? couponDiscount(eligibleSubtotal, input.coupon) : 0n;
  const allocations =
    input.coupon && rawCouponDiscount > 0n
      ? allocateProRata(
          rawCouponDiscount,
          lines.map((line) => (line.eligibleForDiscount ? line.lineSubtotalPaise : 0n)),
        )
      : lines.map(() => 0n);
  const lineResults: PricingLineResult[] = lines.map((line, index) => {
    const taxable = line.lineSubtotalPaise - allocations[index]!;
    const tax =
      taxable > 0n
        ? roundHalfUp(taxable * BigInt(line.taxRateBps), 10000n + BigInt(line.taxRateBps))
        : 0n;
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      mrpPaise: line.mrpPaise,
      lineSubtotalPaise: line.lineSubtotalPaise,
      discountPaise: allocations[index]!,
      taxRateBps: line.taxRateBps,
      taxPaise: tax,
      lineTotalPaise: taxable,
    };
  });
  const discount = lineResults.reduce((sum, line) => sum + line.discountPaise, 0n);
  const merchandise = subtotal - discount;
  const freeDeliveryCoupon = input.coupon?.kind === 'FREE_DELIVERY';
  const thresholdWaived = merchandise >= money(input.fees.freeDeliveryThresholdPaise, 'threshold');
  const deliveryFeeWaived = freeDeliveryCoupon || (thresholdWaived && merchandise > 0n);
  const deliveryAmount = deliveryFeeWaived ? 0n : deliveryFee(merchandise, input.fees);
  const handlingAmount = money(input.fees.handlingFeePaise, 'handling');
  const smallCartAmount =
    merchandise < money(input.fees.smallCartThresholdPaise, 'smallCartThreshold')
      ? money(input.fees.smallCartFeePaise, 'smallCartFee')
      : 0n;
  const surgeAmount = input.fees.surgeEnabled ? money(input.fees.surgeFeePaise, 'surge') : 0n;
  const feeEntries: PricingFeeResult[] = (
    [
      ['DELIVERY', deliveryAmount],
      ['HANDLING', handlingAmount],
      ['SMALL_CART', smallCartAmount],
      ['SURGE', surgeAmount],
    ] as const
  ).map(([kind, amount]) => ({
    kind,
    amountPaise: amount,
    ...feeTax(kind, amount, input.fees.feeTaxRules),
  }));
  const tipFee: PricingFeeResult = { kind: 'TIP', amountPaise: tip, taxPaise: 0n, taxSplit: null };
  const fees = [...feeEntries, tipFee].filter((fee) => fee.amountPaise > 0n);
  const feeTotal = feeEntries.reduce((sum, fee) => sum + fee.amountPaise, 0n);
  const taxTotal =
    lineResults.reduce((sum, line) => sum + line.taxPaise, 0n) +
    fees.reduce((sum, fee) => sum + fee.taxPaise, 0n);
  const total = merchandise + feeTotal + tip;
  let wallet: PricingTotals['wallet'] = null;
  let amountDue = total;
  if (input.wallet) {
    if (
      !Number.isSafeInteger(input.wallet.promoSpendCapBps) ||
      input.wallet.promoSpendCapBps < 0 ||
      input.wallet.promoSpendCapBps > 10000
    )
      throw new Error('INVALID_INPUT');
    const promoCap = (total * BigInt(input.wallet.promoSpendCapBps)) / 10000n;
    const promo =
      BigInt(input.wallet.promoAvailablePaise) < promoCap
        ? BigInt(input.wallet.promoAvailablePaise)
        : promoCap;
    const promoApplied = promo > total ? total : promo;
    const cashRoom = total - promoApplied;
    const cashAvailable = money(input.wallet.cashAvailablePaise, 'cash');
    const cash = cashAvailable < cashRoom ? cashAvailable : cashRoom;
    wallet = { promoPaise: promoApplied, cashPaise: cash };
    amountDue = total - promoApplied - cash;
  }
  return {
    lines: lineResults,
    fees,
    couponDiscountPaise: discount,
    subtotalPaise: subtotal,
    discountPaise: discount,
    feeTotalPaise: feeTotal,
    taxTotalPaise: taxTotal,
    tipPaise: tip,
    totalPaise: total,
    wallet,
    amountDuePaise: amountDue,
    minOrderNotMet: merchandise < minOrder,
    maxOrderExceeded: total > maxOrder,
    deliveryFeeWaived,
  };
}
