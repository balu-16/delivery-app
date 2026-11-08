# Wallet module (P6.2)

Customer cash/promo balances with an append-only ledger, expiring promo lots,
verified top-ups, refund-commitment settlement and maker-checker adjustments.

## Invariants

- Every balance change is one transaction: lock the account row, sample database
  time after the wait, apply the pure bucket rules, insert the ledger row
  (UNIQUE account, bucket, reference, reason = exactly-once) and update the
  versioned balance; CHECK constraints keep balances non-negative (ADR 0008).
- The promo balance always equals the sum of lot remainders; spends consume lots
  FIFO by grant time under the per-order promo cap (`promoSpendCapBps`); expiry
  writes off unspent remainders through a PROMO_EXPIRY ledger row.
- Reversals restore each original bucket exactly once with provenance: promo
  returns to its original lot while unexpired, otherwise to one fresh lot that
  never expires (documented policy of ADR 0008).
- Top-ups create durable gateway intents (min/max/IST-monthly caps) and credit the
  wallet only from the verified capture event consumed through the `wallet`
  outbox consumer; duplicate captures credit exactly once.
- Wallet features stay behind `wallet_enabled`; disabled wallets refuse spend and
  new top-ups with 409 WALLET_DISABLED while existing balances stay readable.

## Events consumed (consumer name `wallet`)

- `payments.topup.captured` -> TOPUP_CREDIT ledger row.
- `payments.refund.settled` -> spend reversal (WALLET_DEBIT source) or REFUND_CREDIT
  (gateway/COD source, wallet destination).

## Lock ordering

Wallet account row, then promo lot rows, then ledger inserts. Wallet code never
locks payment rows first; payment-side flows lock attempt/refund rows before
calling wallet contracts.
