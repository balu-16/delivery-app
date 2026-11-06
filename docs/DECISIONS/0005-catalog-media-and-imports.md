# 0005: Catalog scope, immutable media and durable imports

Date: 6 November 2026. Status: accepted for P3 implementation.

## Context

P3 exposes store-specific assortment before P4 owns stock movements. Customer reads require a valid price and inventory row. Public catalog images, private KYC and import files have different access rules. Upload capabilities remain usable until expiry, so a registered object cannot keep sharing a writable staging key. Async imports must tolerate crashes without bypassing price approvals or applying a completed batch twice.

## Decision

Catalog owns categories, brands, products, variants, prices, synonyms and import jobs. Inventory owns the structural assortment/availability table and contract; P3 creates and seeds zero stock only. P4 introduces receipt-backed movement and reservations without changing the customer availability contract. All customer catalog/search reads derive the store from an owned selected/default address, then apply publication, assortment and current price eligibility.

Represent prices in integer paise and explicit half-open validity windows. Preserve price history. Serialize competing price writes and validate price/publish constraints under the same locks as mutations. Bind qualifying bulk price changes to an immutable maker-checker payload; approval cannot authorize a different set of rows or prices. Audit administrative changes in their business transactions.

An omitted/null `validFrom` means immediate activation at database time after locks. An elapsed requested start activates at that same current time, including a delayed checker decision; it never backdates history. Still-future starts retain their scheduled boundary. Admin and super-admin makers use separate trusted policies; a distinct super-admin checks price/import approval.

Keep shared storage provider wiring independent of identity/catalog controllers to avoid circular module dependencies. Upload capabilities are owner/purpose/type/size bound and accept staging keys only. Registration verifies provider metadata and binds immutable final content, using conditional promotion or equivalent version protection. Public objects receive controlled CDN paths; KYC, input CSV and reports remain private. No API accepts an arbitrary media source URL. Local storage follows the same ownership and registration rules as S3; selecting S3 never falls back to local storage.

Import identity uses a hash of actual immutable bytes plus execution mode and meaningful options/store. Validate the whole bounded UTF-8/BOM-aware stream before catalog mutations; stage validated rows/checkpoints as job metadata. Dry runs write no catalog/price/assortment changes. Real runs commit bounded batches with their checkpoints, use durable lease fencing and recover after interruption. Re-running the same real import returns its durable outcome; a prior dry run cannot suppress it. Revalidate mutable references/price policy at commit and escape report cells that could execute spreadsheet formulas.

Authorized administrators share the file/store/mode deduplication result and can read its job/report; staging uploads remain owner-bound. BullMQ's imports concern carries job-ID hints, with periodic database scans recreating hints after transport loss. Error-report CSVs are immutable private objects referenced by the job, generated with recoverable leases and pre-write cleanup intents. Authenticated downloads stream the persisted report; a public report URL is never returned.

Normalize queries consistently and use parameterized PostgreSQL FTS/trigram matching with explicit ranking and stock placement. Keep query length and result sizes bounded. Cache keys and ETags include store and authoritative catalog/availability revisions; temporal price boundaries must invalidate reads even without an administrative write. A body-derived ETag is acceptable when data has already been read. Later P4 stock writes must advance the availability revision or otherwise invalidate stock-dependent caches.

## Consequences

Add a new migration without changing the accepted P0–P2 migrations. Local and S3 adapters need contract tests; generated signatures/SDK fixtures are distinct from owner-credentialed S3/CloudFront acceptance. Test publication failures, store isolation, temporal boundaries, search ranking, CSV encoding/duplicates/limits, dry-run isolation and crash/idempotency/approval behavior against actual PostgreSQL/Redis where relevant.

The storage contract follows AWS [POST policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html) and [conditional object copy](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html). Streaming parsing uses the documented [CSV parser limits and BOM options](https://csv.js.org/parse/options/), with fatal UTF-8 validation before accepting input.
