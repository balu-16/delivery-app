# 0008: Wallet buckets, spend order and reversals

Date: 6 November 2026. Status: accepted for P6 implementation.

## Context

The wallet holds cash (top-ups, refunds) and promo (cashback) balances. Checkout spends across buckets, refunds reverse earlier funding, and promo credit can expire. Balances must never go negative under concurrency, and the same spend must never be restored twice.

## Decision

Balances live on wallet accounts partitioned into cash and promo buckets; every balance change is one row-locked ledger insert plus balance update in the caller's transaction with a `CHECK (balance >= 0)` and a version column for optimistic readers. The ledger is append-only with a uniqueness key over account, bucket, reference and reason. Funding allocations record which gateway capture, wallet debit or verified COD collection funded an order; refundable capacity is computed per paid source under row lock, and pending plus unknown refund commitments reserve that capacity.

Spend order is promo first up to the configured per-order cap (`promoSpendCapBps`), then cash; reversals restore each amount to its original bucket exactly once, preserving cash/promo provenance. Expiring promo credit is tracked as immutable lots consumed FIFO by grant time, and expiry consumes only unspent lot remainder. Top-ups credit the wallet only after a verified captured webhook processed from the inbox; client callbacks never credit. An ambiguous or failed gateway refund must not simultaneously credit the wallet — wallet fallback requires the original refund outcome to be definitively terminal.

Wallet features stay behind `wallet_enabled`; seeds enable it locally while production defaults keep it off until the owner's activation review. This ADR records the engineering model; PPI/legal review remains an owner step.
