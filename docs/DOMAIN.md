# Implemented domain rules: P0–P4

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

Reservations are internal contracts for future commerce: `HELD` has a payment expiry, `COMMITTED` retains stock without that expiry, and `RESOLVED` records consumption/release. Multi-line holds succeed entirely or report shortages. FEFO allocation uses target delivery time and category shelf life. Pick completion consumes actual quantities and releases shorts. Repeated references cannot duplicate stock effects.

Expiry and quality changes reallocate eligible batches where possible. A promise that cannot be reallocated creates a durable shortage obligation while preserving `0 <= reserved <= onHand`. P6/P7 must consume those obligations through real order/fulfillment compensation; a stock obligation does not mean a refund has happened. Quarantine removes saleability without writing off physical stock. Returned goods require a trusted QC decision before restocking.

## Ownership and time

Identity/account roles are checked against current database state. Store operations also require current store assignment; administration and maker-checker have explicit policies. Mutations with stock effects use retained operation identities, audit and row locks. Authoritative expiry/approval decisions sample database time after relevant locks. All timestamps are UTC; business schedules use Asia/Kolkata.
