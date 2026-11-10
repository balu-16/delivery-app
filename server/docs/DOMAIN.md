# Implemented domain rules: P0–P12

## Catalog and prices

A product belongs to a category, may have a brand, and has one or more saleable variants. Each variant has a unique SKU and an optional unique barcode. Deleted catalog records retain their identities; their SKUs/barcodes are not recycled. Publication requires an HSN, configured GST rate, eligible variant, registered image and expiry tracking for perishables. Administrative writes preserve publication rules and transactional audit/history/event records.

A store's assortment is the presence of a `(store, variant)` inventory row. Assortment alone has zero stock. Customer catalog and search resolve a store from the current customer's selected/default address, then require publication, active catalog references, assortment and a price valid at database time. Store IDs supplied by a customer do not authorize catalog reads.

Prices are integer paise represented as decimal strings in JSON. Validity is half-open: `valid_from <= now < valid_to`; a missing end is unbounded. Database exclusion constraints reject overlapping store/variant windows. Price history remains readable; new prices close preceding windows transactionally. Qualifying changes require an immutable maker-checker intent and a different authorized checker.

Search normalizes case, diacritics and whitespace, expands configured synonyms, and combines exact/prefix/FTS/trigram matching with stock/popularity ordering. Query length and page sizes are bounded. Suggestion caches depend on authoritative revisions and upcoming price/stock time boundaries. ETags describe actual store-scoped results; expired prices or stock cannot remain valid merely because no administrator edited them.

## Media and imports

An upload target binds an owner, purpose, type, size, staging key and expiry. Registration verifies actual object metadata and image signatures, then promotes content to a server-owned final key. A replayed upload cannot replace a registered object. Public product images receive local media/CDN paths. KYC, source CSV and reports remain private; owning an upload target does not grant permission to review another person's KYC.

Imports use immutable file bytes, store and execution mode for their fingerprint. A dry run cannot suppress a real run. Complete validation precedes catalog writes; bounded transactional batches commit alongside checkpoints. The durable job records validation errors, approval state and retry outcome. Recreating a worker resumes the checkpoint. Replaying the same import returns its existing outcome, including across authorized administrators.

## Stock, batches and reservations

Stock quantities are integer counts of one individually saleable variant unit; each package size is a separate variant. Quantity JSON fields are decimal strings. [ADR 0006](DECISIONS/0006-stock-units-reservations-and-expiry.md) records conversion and lock rules.

`onHand` is physical stock, `reserved` is stock allocated to promises, and eligible availability excludes reserved, expired, quarantined, damaged and insufficient-shelf-life batches. Aggregate quantities reconcile to batch totals and immutable ledger deltas. P3 creates zero assortment rows; P4 receipts and authorized audited inventory operations supply quantities.

Reservations integrate with checkout and fulfillment: `HELD` has a payment expiry, `COMMITTED` retains stock without that expiry, and `RESOLVED` records consumption/release. Multi-line holds succeed entirely or report shortages. FEFO allocation uses target delivery time and category shelf life. Pick completion consumes actual quantities and releases shorts. Repeated references cannot duplicate stock effects.

Expiry and quality changes reallocate eligible batches where possible. A promise that cannot be reallocated creates a durable shortage obligation while preserving `0 <= reserved <= onHand`. Real order/fulfillment consumers compensate these obligations; a stock obligation does not itself mean a refund has happened. Quarantine removes saleability without writing off physical stock. Returned goods require a trusted QC decision before restocking.

## Orders, payment and fulfillment

Checkout revalidates the cart, price/configuration snapshot, coupon quota, capacity and funding in the placement transaction. A consumed checkout intent cannot produce a second order. Integer wallet cash and promotional buckets have immutable ledger entries; spending obeys lot expiry and the configured promotional cap. Gateway captures require verified identity, amount and currency; excess or late captures remain separately refundable. Refund commitments reserve the original source cap before external calls, and repeated retries share their durable reference.

Pick tasks consume actual selected batches. Shorts and substitutions produce final charge/tax snapshots and compensate stock/funding through shared order operations. Packing and handover preserve custody; riders cannot silently lose a parcel after pickup. Failed delivery requires the configured arrival/contact gates, then a full quarantined return before QC. COD expectation follows the final charge and remains distinct from cash collected, deposits and payout offsets. Invoices and later credit notes are immutable legal records with transactionally allocated numbers.

## Subscriptions, support and payouts

Subscription schedules use IST calendar dates and effective versions of quantity, frequency, slot and address. Exact cutoff decisions sample database time after locking. Generation claims store-scoped leased work, then uses the account-before-subscription lock order and existing wallet/stock/order contracts. Unique dated occurrences prevent replayed obligations. Insufficient balance retries within the grace window; terminal skips are explicit, repeated failures pause the subscription, and a short subscription parcel is cancelled/refunded as a whole. Picking and dispatch wait for slot lead times independently of nighttime generation.

Ticket ownership and private attachments are enforced for customers and riders; staff internal notes never enter owner views or personal exports. Refund limits/approvals use the shared source-capped money path. Ratings require delivered ownership and a fulfilled target; edit windows, target uniqueness, aggregate thresholds and moderation are enforced.

Weekly payout drafts uniquely claim unallocated earnings before the IST cutoff. Approval rechecks COD dues under the rider accounting lock. A zero-net payout settles internally; positive manual settlements and customer manual refunds require stable references and private evidence. Approved corrections are new records; original approved amounts are retained. No bank-transfer adapter is implied.

## Privacy and durable effects

Erasure serializes against new obligations under the account lock, checks current orders/subscriptions/balances/custody/settlement/holds, and revokes local access before provider/media/tracking cleanup. Completion waits for durable cleanup; an opaque deleted-identity tombstone prevents bootstrap resurrection. Financial/legal records and compact dedupe identities remain retained. Reports use bounded repeatable-read snapshots and private immutable export attempts. Redis delivery can replay or disappear; PostgreSQL obligations and consumer deduplication remain authoritative.

## Ownership and time

Identity/account roles are checked against current database state. Store operations also require current store assignment; administration and maker-checker have explicit policies. Mutations with stock effects use retained operation identities, audit and row locks. Authoritative expiry/approval decisions sample database time after relevant locks. All timestamps are UTC; business schedules use Asia/Kolkata.
