# ADR 0013: Subscriptions, support, payouts and privacy integration

Status: accepted for implementation, 7 November 2026. Acceptance evidence is recorded separately in PROGRESS.md.

Three GPT-6.1 Terra high agents own P10, P11 and P12 respectively. The main agent integrates shared contracts, configuration, runtime composition, storage, manifests and regression checks. No nested agents are used. Existing P0–P9 work and source specifications are preserved.

The owner selected ordinary checkout pricing, fees, minimums and promo limits for subscriptions, and erasure support for all account types. Subscription orders use existing wallet/funding/stock/capacity/confirmation/compensation in one transaction, without customer carts, gateway or COD. D23 governs the exact IST cutoff; slot releases prevent nighttime dispatch. Schedule modifications report their effective date. Generation state and later fulfillment outcome are separate.

Payout drafts claim earnings once. Approval revalidates COD dues under the rider accounting lock and posts an explicit payout offset, never a deposit. Zero net settles internally; positive net is marked paid only with a unique manual payment reference and private evidence. Manual customer refunds remain pending until evidence-backed settlement. Bank transfers are outside this implementation.

Erasure gates are checked against current domain obligations and serialized against new obligations. Local access is revoked before retried provider/storage cleanup. Pool-specific Cognito clients and restricted deleted-identity tombstones prevent bootstrap resurrection. Legal financial/audit history is retained by default; operational PII is anonymized or removed, respecting holds. Workforce erasure needs distinct administrator approval and retains custody, dues, payout, self-erasure and last-super-admin protections.

Exports use bounded streams, immutable per-attempt objects, current authorization before signing, CSV injection protection and fenced finalization. Failed attempts are never presented as completed files. Production/live-provider and P13 acceptance remain separate from local functional evidence.

The S3 streaming adapter uses multipart uploads with `If-None-Match: *` at completion, matching the [official conditional-write contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html). Provider failures abort the attempt; retries use a new attempt object and fenced database finalization. Local streaming writes use exclusive publication and purpose-scoped short-lived capabilities. Tests cover bounded parts, immutable writes and failed-upload cleanup; these are adapter contracts, not live AWS acceptance.

Schedules keep effective-dated address, quantity, frequency and slot changes together. A locked delivery date keeps its prior version. A database lock held across the real IST cutoff verifies the decision uses post-lock database time. List endpoints use bounded cursor pages rather than silently truncating calendars, support messages or payout corrections.

Workforce erasure clears current rider position and deletes GPS history in bounded cleanup batches. A Redis erased-account fence rejects a late in-flight location write; completion waits for cleanup. Financial and approved payout evidence remains retained by policy.

Generation takes short `SKIP LOCKED` claims before entering the account-then-subscription business transaction. Expiring tokens fence stale workers; occurrence and financial uniqueness remain authoritative after restart. Store-scoped processing shares a bounded concurrency limit. Advancing an overdue schedule checks intervening effective versions before selecting the next date. Pricing reads its nine policy keys together, while serviceability, availability and rider-signal reads use the caller's transaction and bypass shared zone caching for uncommitted state.

The single-store, single-wallet contention benchmark and the ten-store generation benchmark are separate workloads. PROGRESS.md records their actual results and environment; a distributed pass does not replace or erase a hotspot failure.
