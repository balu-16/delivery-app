# 0006: Stock units, reservations and expiry

Date: 6 November 2026. Status: accepted for P4 implementation.

## Context

Catalog assortment exists before stock movements. Payment confirmation commits a reservation while picking consumes stock later. Perishable inventory cannot be promised using aggregate quantities alone, and expiring allocated stock must not create a negative reserved/on-hand balance. Orders, payments and fulfillment arrive in later phases.

## Decision

One stock base unit is one individually saleable variant unit. Each packaged size is a distinct variant; case/pack conversions happen before receipt. A future loose-item variant must define an integer measurable unit explicitly. Accept and serialize bigint decimal strings, with no fractional JavaScript quantity arithmetic.

P3 assortment creation supplies zero quantities only. Every P4 change to on-hand has a matching immutable ledger entry and durable business reference. Receipts create batches; aggregate on-hand/reserved reconcile to batch totals/allocations. Catalog prices and product publication do not create stock. Test-only SQL fixtures are not production mutation paths.

Internal commerce/fulfillment commands carry generated order UUID references until P6 adds order foreign keys. They do not create placeholder orders or expose public checkout endpoints. A repeated reference must match its original request. Retain operation identity after a response or reservation is resolved.

Acquire logical reservation/operation locks, then sorted `(store_id, variant_id)` stock rows, then deterministic batch rows. Multi-item reserves are all-or-nothing and report every shortfall. Sample the database clock after waiting for the relevant locks. Select eligible batches FEFO using the promised delivery target and the category minimum remaining shelf life; expired, quarantined and damaged quantities cannot be offered.

Reservations progress from `HELD` to `COMMITTED` to `RESOLVED`. HELD expires at the payment window. Confirmation clears that payment expiry while retaining the allocation. Sweep only expired HELD allocations; confirmed stock remains reserved until consumption or explicit compensation. Picking subtracts actual picked quantities from on-hand and reserved, releases shorts, and records the stock movement once. Release and retry paths preserve the same business reference.

Expiry and damage first try to reallocate affected promises under stock/batch locks. If suitable stock is unavailable, retain invariant-safe allocated quantities and persist an explicit shortfall/compensation obligation for P6/P7 integration. Do not fabricate a completed cancellation or refund. Unallocated expired stock can be written off. Returns become sellable only through an authorized QC decision.

Store mutations require current staff assignment and role. Large adjustment/cycle-count variances require a separate authorized checker through maker-checker; approvals bind the immutable intent and cannot reduce on-hand below reserved. Low-stock/expiry events persist with state changes; actual notification delivery is P9.

The checker must be a currently assigned store manager, including when using the administrative approval route. An admin role alone does not grant physical-stock approval. Manual signed adjustments and physical cycle counts share the variance/expected-version/ledger rules; a physical surplus may increase an existing received, active, unexpired batch. Retained scoped request claims freeze the approval decision in a short transaction, releasing its connection before execution/approval so concurrent requests cannot exhaust a small connection pool through nested transactions.

## Consequences

P4 extends inventory in migration 005 without changing P3 migration 004. Catalog availability must use batch eligibility and see stock revision changes immediately, including before expiry maintenance runs. Maintenance runs on `all`/`worker` only and drains active work before database shutdown.

Expiry write-off and held-reservation sweeps run every minute rather than waiting for a nightly scan. Bounded stock scans rotate by last-checked time so a permanently allocated expired batch cannot starve other batches. This increases maintenance frequency without changing eligibility, retained obligations or ledger rules.

Acceptance requires exactly ten successes for 100 parallel one-unit reservations against stock ten, all-or-nothing shortfalls, reversed-order contention, ledger/batch reconciliation, confirmation-versus-expiry and release/consume races, target-slot shelf life, approvals, authorized QC and scoped API tests. Later P6/P7 phases must exercise the compensation obligations through real order/payment/fulfillment workflows.
