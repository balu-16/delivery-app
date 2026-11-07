# 0010: P7 picking design and consumer-defined P6 integration ports

Date: 7 November 2026. Status: accepted for P7 implementation.

## Context

P7 (store fulfillment) was built in parallel with P6 (orders, wallet, checkout, payments, invoicing), which another implementation session owns and which landed after P7 started. P7 needs order confirmation, order state transitions, financial settlement of shorts and store order reads, but those capabilities did not exist in the tree when P7 began. Waiting would have serialized the phases; inventing P6 internals was forbidden.

## Decision

**Consumer-defined ports.** Picking declares the interfaces it needs in
`src/modules/picking/contracts/fulfillment.ts` — `OrderFulfillment`
(`startPicking`, `markPacked`), `FinancialAdjustments` (`recordShort`),
`OrderCancellation` (`systemCancel`) and `OrderFulfillmentReads`
(`storeOrders`, `orderSummary`) — plus the expected `ORDER_CONFIRMED`
outbox payload. The picking module binds them to a fail-closed stand-in
(`UnboundFulfillment`) that throws `FULFILLMENT_DEPENDENCY_UNAVAILABLE` (503)
inside the caller's transaction, so picking state can never diverge from
order state before P6 binds real implementations. Integration replaces the
stand-in factories with adapters over P6's exported contracts; signatures
there are the recorded dependency assumptions, and differences are absorbed
in adapters, not by changing picking behavior.

**Fail-closed money.** Pick completion consumes fulfilled stock through the
real P4 inventory contracts (`INVENTORY_RESERVATIONS.pick`), then settles
shorts once through `FINANCIAL_ADJUSTMENTS.recordShort`. All-short orders
never complete: they call `OrderCancellation.systemCancel` in the same
transaction and end `CANCELLED` through the shared routine. Until P6 binds,
these paths roll back — completing a task with unresolved money obligations
is impossible rather than approximate.

**Substitution.** v1 substitutes the whole line, only while the item is
`PENDING`, only for a listed candidate (`substitute_candidates`), and only
with `auto_substitution` enabled. The reservation swap is a new inventory
port (`INVENTORY_SUBSTITUTION_SWAPS`): release the original committed line,
reserve and commit the replacement FEFO with shelf-life eligibility,
atomically under the order lock, so a confirmed order never oversells and
the charge is capped by the adjustment contract.

**Handover.** Codes derive from a versioned keyed HMAC
(`PICKING_HANDOVER_SECRET`, production-validated); only the HMAC verifier is
stored. Verification is attempt-limited with lockout; manager override is
role-checked, reason-required and audited. P8 issues records at rider
assignment (`HandoverCodes.issue/presentCode`) and completes custody E2E;
P7 owns only the store-side verification surface.

**Event ownership.** Picking emits `picking.task_changed`,
`picking.task_completed` and `picking.sla_breached` (observability; no
consumers yet). `ORDER_PICKING`/`ORDER_PACKED` are emitted by the order
state machine when P6 executes `startPicking`/`markPacked`. The SLA worker
reports store backlog to the existing auto-pause evaluator and passes rider
availability through unchanged because P8 owns that signal.

## Consequences

- All six roles boot with P7 before P6 lands; store picking endpoints that
  touch money or order state return a typed 503 instead of approximating.
- Pick-task creation is idempotent per `ORDER_CONFIRMED` delivery and by a
  partial unique index on active tasks (SYS-06 half).
- Weighted-item pick tolerance is not implemented: quantities are whole
  saleable units and picked can never exceed expected; a catalog
  weighted-unit flag must precede that feature.
- The manifest keeps P7 operations `implemented` with test files; `verified`
  status and the real-database suite evidence follow the combined run once
  the parallel P6 work compiles and services are available.
