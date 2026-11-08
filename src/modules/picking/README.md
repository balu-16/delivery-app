# Picking (P7 store fulfillment)

Store-side fulfillment of confirmed orders: pick-task creation, claiming,
scanning, shorts, substitutions, packing, handover verification and SLA
maintenance. Pick lists are walk-ordered; every mutation is idempotent by an
`Idempotency-Key` reference stored in `picking_operations`.

## Invariants

- At most one active pick task per order (partial unique index on active
  statuses); the `ORDER_CONFIRMED` consumer is idempotent per delivery.
- Short and substitution decisions remain terminal before completion; the financial
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
`picking.sla_breached` to active notification/dispatch obligations as
appropriate. `ORDER_PACKED` is emitted after packing metadata commits. The SLA
worker reports store pick backlog to the existing auto-pause evaluator and
passes rider availability through unchanged (P8 owns that signal).

## Dependencies

Order state transitions (`startPicking`, `markPacked`), financial
adjustments, system cancellation and store order reads are P6-owned ports
(`contracts/fulfillment.ts`). They are bound to the actual orders module and covered by the real
commerce journey tests. P8 issues handover records bound to the current
rider; store verification checks custody. Heartbeats preserve active picks;
stale tasks return to the pool with item progress retained.
