import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import type { InvoicingOperations } from '../contracts/invoicing.js';

/**
 * The `invoicing` outbox consumer. Tax invoices are issued ONLY from
 * ORDER_DELIVERED events (P8 emits the task-scoped event; tests deliver the
 * same fixture event) - there is deliberately no public endpoint that can
 * bypass delivery. Refund settlements with an issued invoice produce credit
 * notes; refunds before issuance are already reflected in the future payload
 * (built from fulfilled quantities and recorded adjustments).
 */
export class InvoicingEventConsumer {
  static readonly CONSUMER = 'invoicing';
  constructor(private readonly invoicing: InvoicingOperations) {}
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType === 'ORDER_DELIVERED') await this.onDelivered(tx, event);
    else if (event.eventType === 'payments.refund.settled') await this.onRefundSettled(tx, event);
    // Unknown event types are ignored: consumers only apply their own schema.
  }
  private async onDelivered(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    const orderId =
      typeof (event.payload as Record<string, unknown>)['orderId'] === 'string'
        ? ((event.payload as Record<string, unknown>)['orderId'] as string)
        : null;
    if (!orderId) throw new Error('UNPARSEABLE_EVENT');
    await this.invoicing.issueForDeliveredOrder(orderId, tx);
  }
  private async onRefundSettled(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const orderId = typeof payload['orderId'] === 'string' ? payload['orderId'] : null;
    const amountPaise = typeof payload['amountPaise'] === 'string' ? payload['amountPaise'] : null;
    const refundId = typeof payload['refundId'] === 'string' ? payload['refundId'] : null;
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : '';
    if (!orderId || !amountPaise || !refundId) return; // not an order refund we can document
    // COD collections are manual payouts; wallet restorations reverse spends.
    // Only gateway/original-method refunds document a credit note against the
    // issued tax invoice.
    if (['DUPLICATE_CAPTURE', 'LATE_CAPTURE'].includes(reason)) return;
    await this.invoicing.recordCreditNote({
      orderId,
      amountPaise,
      reason: typeof payload['reason'] === 'string' ? payload['reason'] : 'refund processed',
      reference: `refund:${refundId}`,
      refundId,
      tx,
    });
  }
}

/** Guard used by tests and the admin reconciliation view. */
export async function issuedInvoiceCount(tx: TransactionContext, orderId: string): Promise<number> {
  const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM invoice_documents
    WHERE order_id=${orderId}::uuid AND kind='INVOICE' AND status='ISSUED'`.execute(tx);
  return Number(rows.rows[0]?.n ?? '0');
}
