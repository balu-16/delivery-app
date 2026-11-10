import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import {
  buildInvoicePayload,
  financialYearFor,
  formatInvoiceNumber,
  type InvoicePayload,
} from '../domain/invoice-policy.js';
import type {
  InvoiceLinePayload,
  CreditNoteInput,
  InvoiceDocumentKind,
  InvoiceDocumentView,
  InvoiceRendererPort,
  InvoicingOperations,
} from '../contracts/invoicing.js';
import type { StoragePort } from '../../media/contracts/storage.js';
import { parseMoney } from '../../../common/money/money.js';

interface DocumentRow {
  id: string;
  legal_entity_id: string;
  order_id: string;
  kind: InvoiceDocumentKind;
  financial_year: string;
  seq_no: string;
  number: string;
  status: string;
  payload: InvoicePayload;
  renderer_state: string;
  issued_at: Date | null;
  credit_note_for: string | null;
}
const COLUMNS = `id,legal_entity_id::text AS legal_entity_id,order_id::text AS order_id,kind,financial_year,
  seq_no::text AS seq_no,number,status,payload,renderer_state,issued_at,credit_note_for::text AS credit_note_for`;

function view(row: DocumentRow): InvoiceDocumentView {
  return {
    documentId: row.id,
    orderId: row.order_id,
    kind: row.kind,
    number: row.number,
    financialYear: row.financial_year,
    seqNo: row.seq_no,
    status: row.status as InvoiceDocumentView['status'],
    rendererState: row.renderer_state as InvoiceDocumentView['rendererState'],
    issuedAt: row.issued_at?.toISOString() ?? null,
    creditNoteFor: row.credit_note_for,
    payload: row.payload,
  };
}

/**
 * Gapless issuance (D19, SYS-09, ADD-14): the counter increment and the
 * immutable document insert commit in ONE transaction. The single-statement
 * `INSERT .. ON CONFLICT DO UPDATE .. RETURNING last_no` row-locks the
 * (legal_entity, financial_year) counter, so concurrent issuers serialize,
 * a rolled-back transaction consumes no number, and a retry after rollback
 * reuses the same number. Numbers exist only for DELIVERED orders.
 */
export class InvoiceIssuer implements InvoicingOperations {
  constructor(
    private readonly db: Database,
    private readonly renderer: InvoiceRendererPort,
    private readonly storage: StoragePort,
  ) {}
  async issueForDeliveredOrder(
    orderId: string,
    tx: TransactionContext,
  ): Promise<InvoiceDocumentView | null> {
    const order = await this.source(tx, orderId);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    const existing = await this.byOrderAndKind(tx, orderId, 'INVOICE');
    if (existing) return view(existing);
    if (order.status !== 'DELIVERED') throw new Error('ILLEGAL_STATE_TRANSITION'); // no numbered invoice before delivery
    const items = await this.items(tx, orderId);
    const adjustments = await this.adjustments(tx, orderId);
    const now = await databaseTimeAfterLock(tx);
    const payload = buildInvoicePayload(order, items, adjustments);
    const financialYear = financialYearFor(order.delivered_at ?? now);
    const counter = await sql<{ last_no: string }>`INSERT INTO invoice_sequences
      (legal_entity_id,financial_year,last_no) VALUES (${order.legal_entity_id}::uuid,${financialYear},1)
      ON CONFLICT (legal_entity_id,financial_year)
      DO UPDATE SET last_no = invoice_sequences.last_no + 1, updated_at = clock_timestamp()
      RETURNING last_no`.execute(tx);
    const seqNo = BigInt(counter.rows[0]!.last_no);
    const number = formatInvoiceNumber(order.invoice_prefix, financialYear, seqNo);
    const inserted = await sql<DocumentRow>`INSERT INTO invoice_documents
      (id,legal_entity_id,order_id,kind,financial_year,seq_no,number,status,payload,issued_at)
      VALUES (${uuidV7()}::uuid,${order.legal_entity_id}::uuid,${orderId}::uuid,'INVOICE',${financialYear},
        ${seqNo.toString()}::bigint,${number},'ISSUED',${JSON.stringify(payload)}::jsonb,${now.toISOString()}::timestamptz)
      RETURNING ${sql.raw(COLUMNS)}`.execute(tx);
    return view(inserted.rows[0]!);
  }
  async recordCreditNote(input: CreditNoteInput): Promise<InvoiceDocumentView | null> {
    const run = async (tx: TransactionContext) => {
      const amount = parseMoney(input.amountPaise);
      if (amount <= 0n) throw new Error('INVALID_MONEY');
      await sql`SELECT id FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(tx);
      const invoice = await this.byOrderAndKind(tx, input.orderId, 'INVOICE');
      // No issued invoice yet: pre-invoice reductions already adjust the
      // future payload (built from fulfilled quantities at delivery), and the
      // refund obligation is tracked by order_adjustments/refunds.
      if (!invoice || invoice.status !== 'ISSUED') return null;
      if (input.refundId && invoice.issued_at) {
        const refund = await sql<{
          created_at: Date;
        }>`SELECT created_at FROM payment_refunds WHERE id=${input.refundId}::uuid AND order_id=${input.orderId}::uuid`.execute(
          tx,
        );
        if (refund.rows[0] && refund.rows[0].created_at < invoice.issued_at) return null;
      }
      const duplicate = await sql<DocumentRow>`SELECT ${sql.raw(COLUMNS)} FROM invoice_documents
        WHERE order_id=${input.orderId}::uuid AND kind='CREDIT_NOTE'
          AND payload->>'reference' = ${input.reference} LIMIT 1`.execute(tx);
      if (duplicate.rows[0]) return view(duplicate.rows[0]);
      const base = invoice.payload;
      const prior = await sql<{
        amount: string;
      }>`SELECT COALESCE(sum((payload->>'totalPaise')::bigint),0)::text AS amount
        FROM invoice_documents WHERE order_id=${input.orderId}::uuid AND kind='CREDIT_NOTE' AND status='ISSUED'`.execute(
        tx,
      );
      if (amount + BigInt(prior.rows[0]!.amount) > BigInt(base.totalPaise))
        throw new Error('REFUND_LIMIT_EXCEEDED');
      const tax =
        BigInt(base.totalPaise) > 0n
          ? (BigInt(base.taxTotalPaise) * amount) / BigInt(base.totalPaise)
          : 0n;
      const payload: InvoicePayload = {
        ...base,
        kind: 'CREDIT_NOTE',
        lines: [],
        subtotalPaise: amount.toString(),
        discountPaise: '0',
        feeTotalPaise: '0',
        tipPaise: '0',
        taxTotalPaise: tax.toString(),
        totalPaise: amount.toString(),
        adjustments: [{ kind: 'REFUND', amountPaise: amount.toString(), reason: input.reason }],
        netChargePaise: amount.toString(),
        refundsToPostInvoice: [input.reason],
      };
      const now = await databaseTimeAfterLock(tx);
      const financialYear = financialYearFor(now);
      const counter = await sql<{ last_no: string }>`INSERT INTO invoice_sequences
        (legal_entity_id,financial_year,last_no) VALUES (${invoice.legal_entity_id}::uuid,${financialYear},1)
        ON CONFLICT (legal_entity_id,financial_year)
        DO UPDATE SET last_no = invoice_sequences.last_no + 1, updated_at = clock_timestamp()
        RETURNING last_no`.execute(tx);
      const seqNo = BigInt(counter.rows[0]!.last_no);
      const prefix = base.seller.legalEntity.slice(0, 3).toUpperCase() || 'CRN';
      const number = formatInvoiceNumber(prefix, financialYear, seqNo);
      const inserted = await sql<DocumentRow>`INSERT INTO invoice_documents
        (id,legal_entity_id,order_id,kind,financial_year,seq_no,number,status,payload,issued_at,credit_note_for)
        VALUES (${uuidV7()}::uuid,${invoice.legal_entity_id}::uuid,${input.orderId}::uuid,'CREDIT_NOTE',${financialYear},
          ${seqNo.toString()}::bigint,${number},'ISSUED',${JSON.stringify({ ...payload, reference: input.reference, refundId: input.refundId ?? null })}::jsonb,
          ${now.toISOString()}::timestamptz,${invoice.id}::uuid)
        RETURNING ${sql.raw(COLUMNS)}`.execute(tx);
      return view(inserted.rows[0]!);
    };
    return input.tx ? run(input.tx) : transactionWithRetry(this.db, run);
  }
  /** Rendering happens after issuance; failures retry the SAME number. */
  async renderDue(limit: number): Promise<number> {
    const due = await sql<DocumentRow>`SELECT ${sql.raw(COLUMNS)} FROM invoice_documents
      WHERE renderer_state IN ('PENDING','FAILED') ORDER BY created_at LIMIT ${limit}`.execute(
      this.db,
    );
    let rendered = 0;
    for (const row of due.rows) {
      try {
        const body = await this.renderer.render(row.payload, row.number);
        const bytes = Buffer.from(body, 'utf8'),
          key = `private/${row.id}`;
        try {
          await this.storage.putPrivate(key, bytes, this.renderer.contentType);
        } catch (error) {
          // A crash after immutable upload but before the DB update reuses the
          // exact document. An unrelated or incomplete object must still fail.
          const existing = await this.storage.inspect(key);
          if (existing.size !== bytes.length || existing.type !== this.renderer.contentType)
            throw error;
          const stream = await this.storage.open(key),
            chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          if (
            createHash('sha256').update(Buffer.concat(chunks)).digest('hex') !==
            createHash('sha256').update(bytes).digest('hex')
          )
            throw error;
        }
        await sql`UPDATE invoice_documents SET renderer_state='RENDERED',rendered_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=${row.id}::uuid`.execute(this.db);
        rendered += 1;
      } catch {
        await sql`UPDATE invoice_documents SET renderer_state='FAILED',updated_at=clock_timestamp()
          WHERE id=${row.id}::uuid AND renderer_state <> 'RENDERED'`.execute(this.db);
      }
    }
    return rendered;
  }
  async invoiceForOrder(
    orderId: string,
    userId: string,
  ): Promise<{ document: InvoiceDocumentView; content: string | null; contentType: string }> {
    return transactionWithRetry(this.db, async (tx) => {
      const owned = await sql<{ user_id: string }>`SELECT user_id::text AS user_id FROM orders
        WHERE id=${orderId}::uuid`.execute(tx);
      if (owned.rows[0]?.user_id !== userId) throw new Error('ORDER_NOT_FOUND');
      const row = (
        await sql<DocumentRow>`SELECT ${sql.raw(COLUMNS)} FROM invoice_documents
          WHERE order_id=${orderId}::uuid AND kind='INVOICE' ORDER BY created_at DESC LIMIT 1`.execute(
          tx,
        )
      ).rows[0];
      if (!row) throw new Error('INVOICE_NOT_READY');
      let content: string | null = null;
      if (row.renderer_state === 'RENDERED') {
        const stream = await this.storage.open(`private/${row.id}`);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        content = Buffer.concat(chunks).toString('utf8');
      }
      return { document: view(row), content, contentType: this.renderer.contentType };
    });
  }
  private async byOrderAndKind(
    tx: TransactionContext,
    orderId: string,
    kind: InvoiceDocumentKind,
  ): Promise<DocumentRow | null> {
    const rows = await sql<DocumentRow>`SELECT ${sql.raw(COLUMNS)} FROM invoice_documents
      WHERE order_id=${orderId}::uuid AND kind=${kind} ORDER BY created_at DESC LIMIT 1`.execute(
      tx,
    );
    return rows.rows[0] ?? null;
  }
  private async source(
    tx: TransactionContext,
    orderId: string,
  ): Promise<
    | (Parameters<typeof buildInvoicePayload>[0] & {
        status: string;
        legal_entity_id: string;
        invoice_prefix: string;
      })
    | null
  > {
    const rows = await sql<{
      id: string;
      status: string;
      order_number: string;
      user_id: string;
      placed_at: Date;
      delivered_at: Date | null;
      currency: string;
      subtotal_paise: string;
      discount_paise: string;
      fee_total_paise: string;
      tax_total_paise: string;
      tip_paise: string;
      total_paise: string;
      legal_entity: string;
      legal_entity_id: string;
      gstin: string | null;
      fssai_no: string | null;
      invoice_prefix: string;
      buyer_name: string | null;
    }>`SELECT o.id::text AS id, o.status, o.order_number, o.user_id::text AS user_id, o.placed_at, o.delivered_at,
        o.currency, o.subtotal_paise::text AS subtotal_paise, o.discount_paise::text AS discount_paise,
        o.fee_total_paise::text AS fee_total_paise, o.tax_total_paise::text AS tax_total_paise,
        o.tip_paise::text AS tip_paise, o.total_paise::text AS total_paise,
        le.name AS legal_entity, le.id::text AS legal_entity_id, le.gstin, le.fssai_no, le.invoice_prefix,
        u.name AS buyer_name
      FROM orders o
      JOIN stores s ON s.id = o.store_id
      JOIN legal_entities le ON le.id = s.legal_entity_id
      JOIN users u ON u.id = o.user_id
      WHERE o.id = ${orderId}::uuid FOR UPDATE OF o`.execute(tx);
    const row = rows.rows[0];
    if (!row) return null;
    return {
      order_id: row.id,
      order_number: row.order_number,
      user_id: row.user_id,
      placed_at: row.placed_at,
      delivered_at: row.delivered_at,
      currency: row.currency,
      subtotal_paise: row.subtotal_paise,
      discount_paise: row.discount_paise,
      fee_total_paise: row.fee_total_paise,
      tax_total_paise: row.tax_total_paise,
      tip_paise: row.tip_paise,
      total_paise: row.total_paise,
      legal_entity: row.legal_entity,
      gstin: row.gstin,
      fssai_no: row.fssai_no,
      buyer_name: row.buyer_name,
      status: row.status,
      legal_entity_id: row.legal_entity_id,
      invoice_prefix: row.invoice_prefix,
    };
  }
  private async items(tx: TransactionContext, orderId: string) {
    const rows = await sql<{
      variant_id: string;
      name_snapshot: string;
      hsn_code: string;
      ordered_qty: string;
      fulfilled_qty: string;
      short_qty: string;
      mrp_paise: string;
      unit_price_paise: string;
      discount_paise: string;
      tax_paise: string;
      tax_rate_bps: number;
      line_status: string;
      fulfillment_snapshot: InvoiceLinePayload | null;
    }>`SELECT variant_id::text AS variant_id, name_snapshot, hsn_code, ordered_qty::text AS ordered_qty,
        fulfilled_qty::text AS fulfilled_qty, short_qty::text AS short_qty, mrp_paise::text AS mrp_paise,
        unit_price_paise::text AS unit_price_paise, discount_paise::text AS discount_paise,
        tax_paise::text AS tax_paise, tax_rate_bps, line_status,fulfillment_snapshot
      FROM order_items WHERE order_id=${orderId}::uuid ORDER BY created_at,id`.execute(tx);
    return rows.rows;
  }
  private async adjustments(tx: TransactionContext, orderId: string) {
    const rows = await sql<{ kind: string; amount_paise: string; reason: string }>`SELECT kind,
      amount_paise::text AS amount_paise, reason
      FROM order_adjustments WHERE order_id=${orderId}::uuid ORDER BY created_at`.execute(tx);
    return rows.rows;
  }
}

export type { InvoiceDocumentKind };
