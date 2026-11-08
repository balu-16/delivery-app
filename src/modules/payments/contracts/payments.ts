import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Public contracts of the payments module. Checkout (6.3), cancellation (6.4)
 * and reconciliation (6.6) build on these; wallet top-ups (6.2) create
 * attempts through `PAYMENT_ORDERS`. Cross-module callers may import only
 * this file (state types live here so domain internals stay private). Lock
 * ordering (documented for the whole platform): payment attempt/refund rows
 * are locked before wallet account rows; webhook inbox rows are processed one
 * event at a time under that same ordering.
 */
export type AttemptState = 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'UNKNOWN';
export type RefundState = 'PENDING' | 'PROCESSED' | 'FAILED' | 'UNKNOWN';
export type OperationKind = 'ORDER_PAYMENT' | 'WALLET_TOPUP' | 'ORDER_REFUND' | 'WALLET_REFUND';

export const PAYMENT_ORDERS = Symbol('PAYMENT_ORDERS');
export const PAYMENT_WEBHOOKS = Symbol('PAYMENT_WEBHOOKS');
export const PAYMENT_REFUNDS = Symbol('PAYMENT_REFUNDS');
export const PAYMENT_VERIFICATION = Symbol('PAYMENT_VERIFICATION');
export const PAYMENT_FINDINGS = Symbol('PAYMENT_FINDINGS');
export interface PaymentFindings {
  list(
    limit: number,
    cursor?: string,
  ): Promise<{ items: readonly Record<string, unknown>[]; nextCursor: string | null }>;
}
export interface PaymentVerification {
  pollAttempt(attemptId: string, gatewayPaymentId?: string): Promise<boolean>;
}

export interface PaymentIntent {
  attemptId: string;
  orderId: string;
  /** Durable operation reference persisted before the external call. */
  operationReference: string;
  kind: OperationKind;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  amountPaise: string;
  currency: string;
  status: AttemptState;
  createdAt: string;
}

export interface CreateAttemptInput {
  /** Aggregate the attempt funds (order id or top-up intent id). */
  readonly aggregateId: string;
  readonly kind: OperationKind;
  readonly amountPaise: string;
  readonly currency: string;
  readonly receipt?: string;
  readonly operationReference?: string;
  /** Owning user (wallet top-ups record it for the crediting consumer). */
  readonly userId?: string;
  /** Pass to join another unit of work; otherwise a fresh transaction is used. */
  readonly tx?: TransactionContext;
}

/** Durable gateway-order creation; external calls never run inside a DB transaction. */
export interface PaymentOrderOperations {
  recoverPendingBatch(limit: number): Promise<number>;
  createAttempt(input: CreateAttemptInput): Promise<PaymentIntent>;
  /**
   * Runs (or re-drives) the external gateway create for an attempt whose
   * durable row already committed - checkout calls it strictly after its
   * placement transaction. A definitive rejection fails the attempt; an
   * ambiguous outcome recovers through the documented receipt lookup and
   * never recreates the gateway order (ADR 0007).
   */
  completeSetup(operationReference: string, receipt: string): Promise<PaymentIntent>;
  intentByOperationReference(operationReference: string): Promise<PaymentIntent | null>;
  listAttempts(aggregateId: string): Promise<readonly PaymentIntent[]>;
  /**
   * Recovery for a lost create response (ADR 0007): the documented receipt
   * lookup is applied to the pending durable operation; zero or multiple
   * distinct matches leave the attempt UNKNOWN and record a finding.
   */
  recoverPendingOperation(operationReference: string): Promise<PaymentIntent | null>;
}

export type RefundSourceType = 'GATEWAY_CAPTURE' | 'WALLET_DEBIT' | 'COD_COLLECTION';
export type RefundDestination = 'GATEWAY' | 'WALLET' | 'MANUAL_PAYOUT';
export interface RefundView {
  refundId: string;
  refundReference: string;
  orderId: string;
  sourceType: RefundSourceType;
  /** Gateway payment id, wallet spend reference or COD collection id. */
  sourceId: string;
  amountPaise: string;
  destination: RefundDestination;
  status: RefundState;
  gatewayRefundId: string | null;
  reason: string | null;
}
export interface CommitRefundInput {
  /** Stable business operation reference; retries must reuse the same input. */
  readonly refundReference?: string;
  readonly orderId: string;
  readonly sourceType: RefundSourceType;
  readonly sourceId: string;
  readonly amountPaise: string;
  readonly destination: RefundDestination;
  readonly reason?: string;
  readonly initiatedBy?: string;
  /** Required when the source is a gateway capture. */
  readonly gatewayPaymentId?: string;
  readonly tx?: TransactionContext;
}
export type RefundOutcomeStatus = 'PROCESSED' | 'FAILED' | 'PENDING';
export interface RefundSourceCapacity {
  sourceType: RefundSourceType;
  sourceId: string;
  fundedPaise: string;
  committedPaise: string;
  availablePaise: string;
}

/**
 * Refund commitments (D17, ADD-13): a commitment row plus one allocation per
 * source is persisted before the external refund; pending and unknown
 * commitments reserve refundable capacity; an UNKNOWN outcome never credits
 * the wallet; wallet fallback requires a definitively terminal failure.
 */
export interface PaymentRefundOperations {
  commit(input: CommitRefundInput): Promise<RefundView>;
  markManualRefundPaid(input: {
    refundReference: string;
    actorId: string;
    paymentReference: string;
    evidenceMediaId: string;
    idempotencyKey: string;
  }): Promise<RefundView>;
  /**
   * Drives (or re-drives) the external refund for one PENDING gateway
   * commitment using its durable reference; no-op for other destinations.
   * Used after commit (compensation) and by the refund-recovery worker.
   */
  dispatchRefund(refundReference: string): Promise<RefundView>;
  applyOutcome(
    refundReference: string,
    outcome: { status: RefundOutcomeStatus; gatewayRefundId?: string },
  ): Promise<RefundView>;
  /** Documented lookup path for a lost refund response. */
  recoverUnknown(refundReference: string): Promise<RefundView>;
  refundableCapacity(
    orderId: string,
    tx?: TransactionContext,
  ): Promise<readonly RefundSourceCapacity[]>;
  refundsForOrder(orderId: string): Promise<readonly RefundView[]>;
}

export interface WebhookIngestResult {
  inboxId: string;
  duplicate: boolean;
  accepted: boolean;
  state: 'PENDING' | 'QUARANTINED';
  quarantineReason?: 'SIGNATURE_INVALID' | 'CHANGED_BODY' | 'UNPARSEABLE';
}
export type WebhookProcessResult = 'PROCESSED' | 'QUARANTINED' | 'RETRY_SCHEDULED' | 'SKIPPED';
/**
 * Raw webhook inbox (plan 5.4.4): verify the signature over the exact raw
 * bytes, persist the event first, acknowledge quickly, process afterwards via
 * the payments concern queue. Invalid signatures never create business events.
 */
export interface PaymentWebhookIngest {
  ingest(input: {
    gateway: string;
    rawBody: Uint8Array;
    signature: string;
    eventIdHeader: string | null;
  }): Promise<WebhookIngestResult>;
  /** Idempotent worker entry point for one durable inbox event. */
  processOne(inboxId: string): Promise<WebhookProcessResult>;
}
export interface InboxEventView {
  inboxId: string;
  gateway: string;
  eventId: string;
  eventType: string;
  state: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'QUARANTINED';
  quarantineReason: string | null;
  attempts: number;
  createdAt: string;
}
export interface WebhookInboxQuery {
  inboxEvent(inboxId: string): Promise<InboxEventView | null>;
  /** Due PENDING events for recovery scans (Redis loss does not lose work). */
  dueEvents(limit: number): Promise<readonly InboxEventView[]>;
}
export const WEBHOOK_INBOX_QUERY = Symbol('WEBHOOK_INBOX_QUERY');

/**
 * Fraud signals v1 (Section 26, D25): advisory records for admin review;
 * they NEVER block a user or an order by themselves. P12 completes the
 * configurable policy; the recorded signals are the durable evidence.
 */
export const PAYMENT_FRAUD_SIGNALS = Symbol('PAYMENT_FRAUD_SIGNALS');
export interface PaymentFraudSignals {
  /** Repeated failed payment attempts on one order. */
  recordPaymentFailure(orderId: string, attemptId: string): Promise<void>;
  /** Checkout order velocity per user (advisory, non-blocking). */
  recordCheckoutVelocity(userId: string, orderId: string): Promise<void>;
}
