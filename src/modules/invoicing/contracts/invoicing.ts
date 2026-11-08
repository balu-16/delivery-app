import type { TransactionContext } from '../../../platform/database/database.js';
export interface InvoiceLinePayload {
  readonly variantId: string;
  readonly name: string;
  readonly hsn: string;
  readonly quantity: string;
  readonly fulfilledQty: string;
  readonly shortQty: string;
  readonly mrpPaise: string;
  readonly unitPricePaise: string;
  readonly discountPaise: string;
  readonly taxPaise: string;
  readonly taxRateBps: number;
  readonly lineTotalPaise: string;
}

export interface InvoicePayload {
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly orderNumber: string;
  readonly orderPlacedAt: string;
  readonly deliveredAt: string | null;
  readonly seller: {
    readonly legalEntity: string;
    readonly gstin: string | null;
    readonly fssaiNo: string | null;
  };
  readonly buyer: { readonly userId: string; readonly name: string | null };
  readonly currency: string;
  readonly lines: readonly InvoiceLinePayload[];
  readonly subtotalPaise: string;
  readonly discountPaise: string;
  readonly feeTotalPaise: string;
  readonly taxTotalPaise: string;
  readonly tipPaise: string;
  readonly totalPaise: string;
  readonly adjustments: readonly {
    readonly kind: string;
    readonly amountPaise: string;
    readonly reason: string;
  }[];
  readonly refundsToPostInvoice: readonly string[];
  readonly netChargePaise: string;
}

/**
 * Public contracts of the invoicing module (P6.5, D19). Issuance happens
 * ONLY through the `invoicing` outbox consumer of ORDER_DELIVERED (or an
 * authorized internal call inside the same transaction as the delivery
 * transition); there is no public endpoint that can number an invoice before
 * delivery. Cross-module callers import only this file.
 */
export const INVOICING = Symbol('INVOICING');
export const INVOICE_RENDERER = Symbol('INVOICE_RENDERER');

export type InvoiceDocumentKind = 'INVOICE' | 'CREDIT_NOTE';
export type RendererState = 'PENDING' | 'RENDERED' | 'FAILED';

export interface InvoiceDocumentView {
  readonly documentId: string;
  readonly orderId: string;
  readonly kind: InvoiceDocumentKind;
  readonly number: string;
  readonly financialYear: string;
  readonly seqNo: string;
  readonly status: 'DRAFT' | 'ISSUED';
  readonly rendererState: RendererState;
  readonly issuedAt: string | null;
  readonly creditNoteFor: string | null;
  readonly payload: InvoicePayload;
}

/** HTML today; PDF adapters implement the same port later (Section 16). */
export interface InvoiceRendererPort {
  readonly contentType: string;
  render(payload: InvoicePayload, number?: string): Promise<string>;
}

export interface CreditNoteInput {
  readonly orderId: string;
  readonly amountPaise: string;
  readonly reason: string;
  /** Durable reference tying the note to the refund/adjustment (idempotency). */
  readonly reference: string;
  readonly refundId?: string;
  readonly createdBy?: string;
  readonly tx?: TransactionContext;
}

export interface InvoiceContentView {
  readonly document: InvoiceDocumentView;
  /** Present once rendering succeeded; authorized reads stream this content. */
  readonly content: string | null;
  readonly contentType: string;
}

/**
 * The issuance/credit-note API. Gapless numbering per (legal entity,
 * financial year April-March IST): the counter row lock, the increment and
 * the immutable document insert commit in ONE transaction, so rollback
 * consumes no number and concurrent issuers serialize on the counter.
 */
export interface InvoicingOperations {
  /** Numbers and issues the tax invoice for a DELIVERED order (idempotent). */
  issueForDeliveredOrder(
    orderId: string,
    tx: TransactionContext,
  ): Promise<InvoiceDocumentView | null>;
  /** Post-invoice reduction -> credit note referencing the issued document. */
  recordCreditNote(input: CreditNoteInput): Promise<InvoiceDocumentView | null>;
  /** Renders PENDING/FAILED documents; retries reuse the SAME number. */
  renderDue(limit: number): Promise<number>;
  /** Authorized customer retrieval: owner-checked, content only when rendered. */
  invoiceForOrder(orderId: string, userId: string): Promise<InvoiceContentView>;
}
