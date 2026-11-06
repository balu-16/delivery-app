import { assertMoney } from './catalog.js';
export interface ImportRow {
  sku: string;
  barcode: string | null;
  productName: string;
  variantName: string;
  categoryId: string;
  hsnCode: string;
  gstRateBps: number;
  perishable: boolean;
  expiryTracking: boolean;
  sellingPaise: string;
  mrpPaise: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseImportRow(input: Record<string, string>, allowedGst: number[]): ImportRow {
  const value = (name: string, max: number) => {
    const v = input[name]?.trim() ?? '';
    if (!v || v.length > max) throw new Error(`INVALID_${name.toUpperCase()}`);
    return v;
  };
  const sku = value('sku', 100),
    productName = value('product_name', 200),
    variantName = value('variant_name', 200),
    categoryId = value('category_id', 36),
    hsnCode = value('hsn_code', 32);
  const barcode = input.barcode?.trim() || null;
  if (barcode && barcode.length > 100) throw new Error('INVALID_BARCODE');
  const gst = value('gst_rate_bps', 5);
  if (!/^\d+$/.test(gst) || !allowedGst.includes(Number(gst))) throw new Error('INVALID_GST');
  if (!uuid.test(categoryId)) throw new Error('INVALID_CATEGORY');
  const bool = (name: string) => {
    const v = value(name, 5);
    if (v !== 'true' && v !== 'false') throw new Error(`INVALID_${name.toUpperCase()}`);
    return v === 'true';
  };
  const perishable = bool('perishable'),
    expiryTracking = bool('expiry_tracking');
  if (perishable && !expiryTracking) throw new Error('EXPIRY_TRACKING_REQUIRED');
  const sellingPaise = value('selling_paise', 18),
    mrpPaise = value('mrp_paise', 18);
  assertMoney(sellingPaise, mrpPaise);
  return {
    sku,
    barcode,
    productName,
    variantName,
    categoryId,
    hsnCode,
    gstRateBps: Number(gst),
    perishable,
    expiryTracking,
    sellingPaise,
    mrpPaise,
  };
}
/** Prevent formulas when an operator opens a generated report in a spreadsheet. */
export function csvCell(value: string): string {
  const safe = /^[\s]*[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
