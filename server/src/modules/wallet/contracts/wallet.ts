import type { Json, TransactionContext } from '../../../platform/database/database.js';

/**
 * Wallet contracts (ADR 0008, D16). Checkout (6.3), cancellation (6.4) and
 * subscription generation (P10) build on `WALLET_SPENDER` / `WALLET_FUNDING`.
 * Lock ordering: wallet operations take the account row lock first, then lot
 * rows, then append ledger rows; wallet code never locks payment rows first
 * (payment-side flows lock attempt/refund rows before calling the wallet).
 */
export const WALLET_SPENDER = Symbol('WALLET_SPENDER');
export const WALLET_VIEWS = Symbol('WALLET_VIEWS');
export const WALLET_TOPUPS = Symbol('WALLET_TOPUPS');
export const WALLET_FUNDING = Symbol('WALLET_FUNDING');
export const WALLET_ADJUSTMENTS = Symbol('WALLET_ADJUSTMENTS');

export type WalletBucket = 'cash' | 'promo';
export const WALLET_REASONS = [
  'ORDER_PAYMENT',
  'ORDER_PAYMENT_REVERSAL',
  'TOPUP_CREDIT',
  'PROMO_GRANT',
  'PROMO_EXPIRY',
  'REFUND_CREDIT',
  'ADMIN_ADJUSTMENT',
] as const;
export type WalletReason = (typeof WALLET_REASONS)[number];
export interface WalletBalances {
  userId: string;
  cashPaise: string;
  promoPaise: string;
  version: string;
}
export interface SpendResult {
  promoPaise: string;
  cashPaise: string;
}
export interface SpendOptions {
  /** Overrides the configured per-order promo cap (bp of the spend amount). */
  readonly promoCapBps?: number;
  readonly promoCapBasePaise?: string;
}
/**
 * Money movement is one transaction: ledger insert plus locked balance update
 * (CHECK >= 0, versioned). Ledger uniqueness (account, bucket, reference,
 * reason) is the natural exactly-once idempotency for every effect.
 */
export interface WalletSpender {
  /** Debits promo first (up to the per-order cap) then cash; throws WALLET_INSUFFICIENT. */
  spend(
    userId: string,
    reference: string,
    amountPaise: string,
    tx: TransactionContext,
    opts?: SpendOptions,
  ): Promise<SpendResult>;
  /**
   * Restores the original buckets of one spend exactly once, preserving
   * provenance; promo returns to its original lot while unexpired, otherwise
   * to a fresh lot that does not expire. Referral grants retain their
   * original expiry and are immediately expired if restored after it.
   */
  reverseSpend(
    reference: string,
    tx?: TransactionContext,
    partial?: { amountPaise: string; reversalReference: string },
  ): Promise<boolean>;
  credit(input: {
    userId: string;
    bucket: WalletBucket;
    amountPaise: string;
    reason: WalletReason;
    refType: string;
    refId: string;
    /** Promo grants may carry an expiry. */
    expiresAt?: string;
    tx?: TransactionContext;
  }): Promise<boolean>;
  /** Administrative credit/debit inside an approved maker-checker execution. */
  adjust(input: {
    userId: string;
    bucket: WalletBucket;
    /** Positive credits, negative debits; debits fail on insufficient funds. */
    deltaPaise: string;
    refId: string;
    tx: TransactionContext;
  }): Promise<void>;
}
export interface WalletFundingInput {
  readonly orderId: string;
  readonly attemptId?: string;
  /** The wallet spend reference used for `spend`, when the wallet funded part. */
  readonly walletSpendReference?: string;
  readonly promoPaise: string;
  readonly cashPaise: string;
  readonly tx?: TransactionContext;
}
/** Per-order funding records define refundable capacity per paid source. */
export interface WalletFunding {
  record(input: WalletFundingInput): Promise<void>;
}
export interface WalletLedgerEntry {
  id: string;
  bucket: WalletBucket;
  deltaPaise: string;
  reason: WalletReason;
  refType: string;
  refId: string;
  balanceAfter: string;
  createdAt: string;
}
export interface WalletLedgerPage {
  items: readonly WalletLedgerEntry[];
  nextCursor: string | null;
}
export interface WalletViews {
  balances(userId: string): Promise<WalletBalances>;
  ledger(userId: string, limit: number, cursor?: string): Promise<WalletLedgerPage>;
  adminLedger(
    filter: { userId?: string; bucket?: WalletBucket; reason?: WalletReason },
    limit: number,
    cursor?: string,
  ): Promise<WalletLedgerPage>;
}
export interface WalletTopupIntent {
  topupId: string;
  operationReference: string;
  gatewayOrderId: string | null;
  amountPaise: string;
  currency: string;
  provider: 'fake' | 'razorpay';
  /** Public checkout key for Razorpay; the fake provider returns null. */
  publicKeyId: string | null;
}
/** Top-ups are gateway intents; the wallet is credited only from verified captures. */
export interface WalletTopups {
  /**
   * Creates (or resumes) one top-up intent. `intentId` binds the intent to an
   * idempotency operation so retries never create a second gateway order; the
   * gateway create runs outside any transaction with documented recovery.
   */
  create(
    userId: string,
    amountPaise: string,
    opts?: { intentId?: string },
  ): Promise<WalletTopupIntent>;
}
export interface WalletAdjustmentRequest {
  direction: 'CREDIT' | 'DEBIT';
  bucket: WalletBucket;
  amountPaise: string;
  userId: string;
  reason: string;
}
/** Manual money moves require maker-checker (Section 24.5) and audit records. */
export interface WalletAdjustments {
  request(makerId: string, input: WalletAdjustmentRequest): Promise<string>;
  /** A different authorized checker approves and executes the adjustment. */
  approve(checkerId: string, requestId: string): Promise<void>;
}
export type WalletEventPayload = Json;
