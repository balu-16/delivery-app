import type { InvoicePayload } from '../domain/invoice-policy.js';
import type { InvoiceRendererPort } from '../contracts/invoicing.js';

function esc(value: string | null | undefined): string {
  return (value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function money(value: string, currency: string): string {
  const paise = BigInt(value);
  const sign = paise < 0n ? '-' : '';
  const abs = (paise < 0n ? -paise : paise).toString().padStart(3, '0');
  return `${sign}${currency} ${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/**
 * Deterministic HTML invoice rendering (Section 16: HTML now, PDF later).
 * The same payload always renders byte-identical output, so a rendering
 * retry after failure rewrites the same document content for the SAME
 * immutable number.
 */
export class HtmlInvoiceRenderer implements InvoiceRendererPort {
  readonly contentType = 'text/html; charset=utf-8';
  async render(payload: InvoicePayload, number?: string): Promise<string> {
    const rows = payload.lines
      .map(
        (line) => `      <tr>
        <td>${esc(line.name)}</td><td>${esc(line.hsn)}</td>
        <td>${line.fulfilledQty}</td><td>${money(line.unitPricePaise, payload.currency)}</td>
        <td>${money(line.taxPaise, payload.currency)}</td>
        <td>${money(line.lineTotalPaise, payload.currency)}</td>
      </tr>`,
      )
      .join('\n');
    const adjustments = payload.adjustments.length
      ? `    <h3>Adjustments</h3>\n    <ul>${payload.adjustments
          .map(
            (a) =>
              `<li>${esc(a.kind)}: ${money(a.amountPaise, payload.currency)} — ${esc(a.reason)}</li>`,
          )
          .join('')}</ul>`
      : '';
    return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${esc(payload.kind)} ${esc(payload.orderNumber)}</title></head>
  <body>
    <h1>${esc(payload.kind)} ${esc(number)}</h1>
    <p>Order ${esc(payload.orderNumber)} · placed ${esc(payload.orderPlacedAt)} · delivered ${esc(payload.deliveredAt)}</p>
    <p>Seller: ${esc(payload.seller.legalEntity)}${payload.seller.gstin ? ` · GSTIN ${esc(payload.seller.gstin)}` : ''}${payload.seller.fssaiNo ? ` · FSSAI ${esc(payload.seller.fssaiNo)}` : ''}</p>
    <table>
      <thead><tr><th>Item</th><th>HSN</th><th>Qty</th><th>Unit</th><th>Tax</th><th>Total</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <p>Subtotal ${money(payload.subtotalPaise, payload.currency)} · discount ${money(payload.discountPaise, payload.currency)} · fees ${money(payload.feeTotalPaise, payload.currency)} · tax ${money(payload.taxTotalPaise, payload.currency)} · tip ${money(payload.tipPaise, payload.currency)}</p>
    <p><strong>Total ${money(payload.totalPaise, payload.currency)}</strong> · net ${money(payload.netChargePaise, payload.currency)}</p>
${adjustments}
  </body>
</html>
`;
  }
}
