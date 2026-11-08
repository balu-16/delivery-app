# Payments module (P6.1)

Gateway-order creation, raw webhook inbox, payment attempts and refund commitments.

## Invariants

- Every create/refund persists a `durable_operations` row (UNIQUE reference) plus a
  `payment_attempts`/`payment_refunds` commitment BEFORE the external call; external
  calls run outside DB transactions; ambiguous outcomes recover through the
  documented lookup paths and never recreate a gateway effect (ADR 0007, D17).
- Attempts are modelled separately from order funding (D18): captures may supersede
  failures, stale failures can never unpay a capture, distinct captures are persisted as separate receipts; excess order captures
  create source-capped refunds and reconciliation findings.
- Webhooks are signature-verified over the exact raw bytes, persisted first with
  UNIQUE (gateway, gateway_event_id), acknowledged with 200, then processed via the
  `payments` concern queue; duplicates are no-ops; changed-body replays with the same
  event id are quarantined, never processed; amount/currency mismatches quarantine
  the event and leave the attempt untouched.
- Refund commitments reserve per-source capacity (gateway capture, wallet debit, COD
  collection) while PENDING or UNKNOWN; UNKNOWN never credits the wallet; the wallet
  fallback requires a definitively terminal failure (ADR 0008).

## Events

- `payments.funding.captured` / `payments.funding.failed` (aggregate `payment_attempt`, consumer
  `orders` — registered by the checkout/orders slice P6.3).
- `payments.topup.captured` (aggregate `wallet_topup`, consumers `wallet`, `invoicing`, and `notifications`).
- `payments.refund.settled` (aggregate `payment_refund`, consumers `wallet`, `invoicing`, and `notifications`).

## Lock ordering

Payment attempt/refund rows are locked before wallet account rows; webhook inbox
events are claimed (PROCESSING + attempt counter) before the effect transaction.
