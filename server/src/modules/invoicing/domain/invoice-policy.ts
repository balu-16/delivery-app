import type { InvoicePayload, InvoiceLinePayload } from '../contracts/invoicing.js';
export type { InvoicePayload, InvoiceLinePayload } from '../contracts/invoicing.js';
/**
 * Invoice policy (D19, TIM-01). Financial years run April-March on the
 * Asia/Kolkata calendar: an invoice issued on 31 March 23:59 IST belongs to
 * the old year, one second later to the new one. All pure; unit-tested with
 * fixed instants including the exact IST midnight crossover.
 */
const IST_OFFSET_MINUTES = 330;

/** 'YYYY-YY' financial year label for an instant, computed on the IST calendar. */
export function financialYearFor(instant: Date): string {
  const ist = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  const startYear = ist.getUTCFullYear() - (ist.getUTCMonth() + 1 < 4 ? 1 : 0);
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

export function formatInvoiceNumber(prefix: string, financialYear: string, seqNo: bigint): string {
  const clean = (prefix || 'INV').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'INV';
  return `${clean}-${financialYear}-${seqNo.toString().padStart(6, '0')}`;
}

export interface InvoiceSourceRow {
  readonly order_id: string;
  readonly order_number: string;
  readonly user_id: string;
  readonly placed_at: Date;
  readonly delivered_at: Date | null;
  readonly currency: string;
  readonly subtotal_paise: string;
  readonly discount_paise: string;
  readonly fee_total_paise: string;
  readonly tax_total_paise: string;
  readonly tip_paise: string;
  readonly total_paise: string;
  readonly legal_entity: string;
  readonly gstin: string | null;
  readonly fssai_no: string | null;
  readonly buyer_name: string | null;
}

export interface InvoiceSourceItem {
  readonly variant_id: string;
  readonly name_snapshot: string;
  readonly hsn_code: string;
  readonly ordered_qty: string;
  readonly fulfilled_qty: string;
  readonly short_qty: string;
  readonly mrp_paise: string;
  readonly unit_price_paise: string;
  readonly discount_paise: string;
  readonly tax_paise: string;
  readonly tax_rate_bps: number;
  readonly line_status: string;
  readonly fulfillment_snapshot?: InvoiceLinePayload | null;
}

/**
 * Builds the immutable payload from FULFILLED quantities and final amounts
 * (D19): pre-invoice shorts are already reflected because line totals use
 * the picked state and the recorded adjustments; post-invoice reductions are
 * corrected through credit notes instead of editing this payload.
 */
export function buildInvoicePayload(
  order: InvoiceSourceRow,
  items: readonly InvoiceSourceItem[],
  adjustments: readonly { kind: string; amount_paise: string; reason: string }[],
): InvoicePayload {
  const lines: InvoiceLinePayload[] = items.map(
    (item) =>
      item.fulfillment_snapshot ?? {
        variantId: item.variant_id,
        name: item.name_snapshot,
        hsn: item.hsn_code,
        quantity: item.ordered_qty,
        fulfilledQty: item.fulfilled_qty,
        shortQty: item.short_qty,
        mrpPaise: item.mrp_paise,
        unitPricePaise: item.unit_price_paise,
        discountPaise: (
          (BigInt(item.discount_paise) * BigInt(item.fulfilled_qty)) /
          BigInt(item.ordered_qty)
        ).toString(),
        taxPaise: (
          (BigInt(item.tax_paise) * BigInt(item.fulfilled_qty)) /
          BigInt(item.ordered_qty)
        ).toString(),
        taxRateBps: item.tax_rate_bps,
        lineTotalPaise: (
          BigInt(item.unit_price_paise) * BigInt(item.fulfilled_qty) -
          (BigInt(item.discount_paise) * BigInt(item.fulfilled_qty)) / BigInt(item.ordered_qty)
        ).toString(),
      },
  );
  const subtotal = lines.reduce(
    (sum, line) => sum + BigInt(line.unitPricePaise) * BigInt(line.fulfilledQty),
    0n,
  );
  const discount = lines.reduce((sum, line) => sum + BigInt(line.discountPaise), 0n);
  const originalItemTax = items.reduce((sum, item) => sum + BigInt(item.tax_paise), 0n);
  const tax =
    BigInt(order.tax_total_paise) -
    originalItemTax +
    lines.reduce((sum, line) => sum + BigInt(line.taxPaise), 0n);
  const total = subtotal - discount + BigInt(order.fee_total_paise) + BigInt(order.tip_paise);
  const adjustmentTotal = adjustments
    .filter(
      (a) =>
        ![
          'SHORT_REFUND',
          'DAMAGED_REFUND',
          'LATE_CAPTURE_REFUND',
          'DUPLICATE_CAPTURE_REFUND',
        ].includes(a.kind),
    )
    .reduce((sum, a) => sum + BigInt(a.amount_paise), 0n);
  return {
    kind: 'INVOICE',
    orderNumber: order.order_number,
    orderPlacedAt: order.placed_at.toISOString(),
    deliveredAt: order.delivered_at?.toISOString() ?? null,
    seller: {
      legalEntity: order.legal_entity,
      gstin: order.gstin,
      fssaiNo: order.fssai_no,
    },
    buyer: { userId: order.user_id, name: order.buyer_name },
    currency: order.currency,
    lines,
    subtotalPaise: subtotal.toString(),
    discountPaise: discount.toString(),
    feeTotalPaise: order.fee_total_paise,
    taxTotalPaise: tax.toString(),
    tipPaise: order.tip_paise,
    totalPaise: total.toString(),
    adjustments: adjustments.map((a) => ({
      kind: a.kind,
      amountPaise: a.amount_paise,
      reason: a.reason,
    })),
    refundsToPostInvoice: [],
    netChargePaise: (total - adjustmentTotal).toString(),
  };
}
