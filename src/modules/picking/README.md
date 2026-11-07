# Picking (P7 store fulfillment)

Store-side fulfillment of confirmed orders: pick-task creation, claiming,
scanning, shorts, substitutions, packing, handover verification and SLA
maintenance. Pick lists are walk-ordered; every mutation is idempotent by an
`Idempotency-Key` reference stored in `picking_operations`.

## Invariants

- At most one active pick task per order (partial unique index on active
  statuses); the `ORDER_CONFIRMED` consumer is idempotent per delivery.
- Item state changes before completion are freely revertible; the financial
  adjustment (refund obligation, substitution charge cap) is computed exactly
  once at completion through the P6 `FINANCIAL_ADJUSTMENTS` contract.
- Completion consumes fulfilled stock through `INVENTORY_RESERVATIONS.pick`
  with one aggregated line per resolved variant; shorts release their
  reservations without decrementing on-hand.
- Substitution atomically swaps the reservation line through
  `INVENTORY_SUBSTITUTION_SWAPS` (release original, reserve+commit
  replacement, FEFO, shelf-life eligible) and never raises the customer's
  charge beyond the original item.
- Handover codes are derived with a versioned keyed HMAC and never stored in
  plaintext; verification is attempt-limited with lockout, and manager
  overrides are audited.

## Events and consumers

Consumes `ORDER_CONFIRMED` (producer: P6 orders; delivery consumer name
`picking`). Emits `picking.task_changed`, `picking.task_completed` and
`picking.sla_breached` (observability; no active consumers yet). The SLA
worker reports store pick backlog to the existing auto-pause evaluator and
passes rider availability through unchanged (P8 owns that signal).

## Dependencies

Order state transitions (`startPicking`, `markPacked`), financial
adjustments, system cancellation and store order reads are P6-owned ports
(`contracts/fulfillment.ts`). Until P6 binds real implementations, the module
boots with a fail-closed stand-in: affected calls throw
`FULFILLMENT_DEPENDENCY_UNAVAILABLE` (503) and roll back, so picking state can
never diverge from order state. Full handover custody E2E belongs to P8, which
issues handover records at rider assignment.
