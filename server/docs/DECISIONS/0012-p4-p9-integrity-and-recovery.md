# ADR 0012: Integrated purchasing, custody and recovery

Status: accepted, 7 November 2026. Supersedes the temporary unbound-provider assumptions in ADRs 0010 and 0011.

P4–P9 now share the real commerce flow. The repair keeps the master specification and original phase plan as the requirements reference; local acceptance does not imply cloud activation or later-phase completion.

- Checkout revalidates cart, price, coupon and configuration inside placement. Capacity, inventory, coupon, wallet and order changes roll back together. A cart intent can create one order across distinct HTTP keys.
- Capture receipts record every distinct gateway payment. Refund capacity is bound to the order and paid source, including wallet reversal provenance. A pending or unknown refund reserves capacity; only a definitive gateway failure may fall back to the wallet.
- Refund dispatch commits UNKNOWN before external I/O. A nonblocking session advisory lock fences dispatch against concurrent outcomes without holding a transaction across the gateway call. A crash uses provider lookup; ambiguity never creates a second credit. Recovery is bounded and escalates unresolved work.
- Inventory reservation generations preserve resolved cycles. Picking consumes selected batches, retains partial shorts and freezes final commercial line snapshots. Replacement charges cannot exceed the original charge. The final invoice uses those snapshots.
- Handover codes bind the current rider and retained key version. The delivery code is four digits and owned by the orders module. Its HMAC verifier and durable attempt counter are shared by confirmation and dispatch; the duplicate P8 implementation was removed.
- An active administrator may reset a locked delivery-code verifier only for an `OUT_FOR_DELIVERY` order with assigned, unreleased rider custody. The reason is audited; the reset clears attempts and the lock, and delivery still requires proof.
- COD retains an expected collection amount independently of actual rider cash entries. Fulfillment reductions lower the expectation; recording the wrong cash amount cannot redefine it.
- Failure after pickup retains custody. A full store return enters quarantine before custody release and source-capped compensation. Manual reassignment applies only before pickup.
- An administrator may hold or resume a `CONFIRMED`, `PICKING` or `PACKED` order before pickup. Order history and audit retain the actor and reason; picking, packing, handover, dispatch and pickup respect the hold. Cancellation before pickup returns already picked goods to quarantined inventory before releasing remaining obligations; QC decides subsequent disposition.
- Customer-unreachable failure requires the configured wait after arrival and the configured number of recorded contacts for the current rider and delivery attempt. A rider flags a wrong address; an administrator can resolve the flag as a failure only after the same wait and contact checks. The failed parcel remains in rider custody until the return workflow releases it.
- Invoice issuance locks the delivered order before checking for an existing document. Number allocation and immutable issuance commit together. Rendering retries verify existing immutable bytes. Pre-invoice reductions belong in the invoice; later reductions create credit notes.
- Worker realtime publications go through Redis to audience instances, which forward locally to avoid duplicate adapter fan-out. Socket authorization is rechecked and expiry disconnects the session. HTTP snapshots remain the recovery path.
- Notification leases fence delivery updates. Device results retain only retryable failures; token cleanup checks owner and registration. Known malformed/versioned events remain observable. External send ambiguity can still duplicate delivery, so stable provider identifiers/collapse controls are used where available.

Migrations 011–025 carry forward repairs; 008 retains its original definition. Migration 013 deliberately forbids downgrade because delivery history is retained. The populated migration test upgrades from 010 and round-trips the reversible repairs above 013.

The pnpm workspace uses `allowBuilds`; the obsolete package-level `onlyBuiltDependencies` field was removed. Firebase client web-config generation is disabled for this server project. See the [pnpm build policy documentation](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/build.md).

Evidence: the [commerce journeys](../../test/integration/commerce/journeys.spec.ts), [refund fence](../../test/integration/payments/refund-fencing.spec.ts), [cross-instance publication](../../test/integration/realtime/worker-broadcast.spec.ts), [migration upgrade](../../test/integration/platform/migration-integrity.spec.ts), and the final check record in [PROGRESS.md](../PROGRESS.md).
