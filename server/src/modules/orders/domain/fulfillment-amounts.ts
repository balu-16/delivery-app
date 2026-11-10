/** Original discount is retained proportionately; substitutions can only lower the charge. */
export function fulfillmentAmounts(input: {
  ordered: bigint;
  fulfilled: bigint;
  unit: bigint;
  discount: bigint;
  replacementUnit?: bigint;
  taxBps: number;
}) {
  const { ordered, fulfilled, unit, discount, taxBps } = input;
  if (
    ordered <= 0n ||
    fulfilled < 0n ||
    fulfilled > ordered ||
    unit < 0n ||
    discount < 0n ||
    discount > unit * ordered ||
    !Number.isSafeInteger(taxBps) ||
    taxBps < 0 ||
    taxBps > 10000 ||
    (input.replacementUnit !== undefined && input.replacementUnit < 0n)
  )
    throw new Error('INVALID_INPUT');
  const originalNet = unit * ordered - discount,
    cap = (originalNet * fulfilled) / ordered;
  const finalUnit =
    input.replacementUnit !== undefined && input.replacementUnit < unit
      ? input.replacementUnit
      : unit;
  const originalDiscount = unit * fulfilled - cap;
  const discounted = finalUnit * fulfilled - originalDiscount;
  const net = discounted < 0n ? 0n : discounted > cap ? cap : discounted;
  const divisor = 10000n + BigInt(taxBps);
  return {
    unit: finalUnit,
    net,
    discount: finalUnit * fulfilled - net,
    tax: (net * BigInt(taxBps) + divisor / 2n) / divisor,
    reduction: originalNet - net,
  };
}
