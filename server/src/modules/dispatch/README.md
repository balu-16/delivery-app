# Dispatch (P8 delivery tasks, offers, COD completion, delivery codes)

Last-mile coordination: idempotent delivery-task creation from
`ORDER_CONFIRMED`, the configured dispatch trigger (ON_PICK_START via
`picking.task_changed`), GEO prefilter → DB revalidation → pure scoring →
sequential offers with expiry/decline cooldowns/radius widening/no-rider
alerts/auto-cancel, atomic rider acceptance, custody transitions, D20
delivery codes over 007's `order_code_verifiers`, COD collection gating and
exactly-once earnings.

## Invariants

- Exactly one active delivery task per order (partial unique index; the
  confirmation consumer is idempotent per delivery — SYS-06).
- At most one assigned rider per task, bounded concurrent tasks and a
  bounded COD cash-in-hand per rider (SYS-05): acceptance is an atomic
  conditional update under order → task → rider status row locks, and every
  candidate is revalidated from DB state under locks (D22 — Redis GEO
  membership alone never qualifies).
- Before pickup, unreachable/dropped riders are unassigned and re-dispatched
  with `attempt_no+1`; after pickup custody is preserved and escalation is
  audited (D21).
- Every transition writes `delivery_task_history` and an outbox event in the
  same transaction (SYS-08).
- Delivery completes only with a verified 4-digit code (attempt-limited with
  durable lockout, constant-time compare, only the HMAC verifier stored —
  D20) or contactless POD, and mismatched COD never reaches DELIVERED
  (PAY-09): the discrepancy is recorded for resolution.
- Earnings are computed exactly once per delivered task (`UNIQUE(task_id)`)
  from pure configuration.

## Events

Consumes `ORDER_CONFIRMED` (consumer `dispatch`, producer P6) and
`picking.task_changed`/`ORDER_PACKED` (consumer `dispatch-trigger` for the
configured trigger). Emits `delivery.task_assigned`, `delivery.task_changed`,
`delivery.completed`, `delivery.failed`, `delivery.custody_escalation`,
`dispatch.no_rider`, `dispatch.rider_unreachable` → `['notifications']` and
`ORDER_DELIVERED` → `['invoicing','notifications']`. Earnings settle in
the delivery transaction.

Realtime: `/rider` namespace (`offer.created`, `offer.revoked`,
`task.updated`, `task.cancelled`) and `/customer` namespace (`order.status`,
`eta.updated`, throttled `rider.location`) are registered by this module on
the platform gateway; clients are receive-only with snapshots on connect and
HTTP polling as the guaranteed fallback.

## Dependencies

Order state transitions and reads (`ORDER_DELIVERY`, `ORDER_DELIVERY_READS`,
`ORDER_SYSTEM_CANCEL`) are P6-owned ports (ADR 0011). They are bound to the actual orders module; custody and order
transitions commit together. Consumes `RIDER_ELIGIBILITY` (riders),
`RIDER_GEO`/`ETA_PROVIDER` (tracking) and `HANDOVER_CODES`/`HANDOVER_STATUS`
(picking). COD gating uses the adjusted expected collection amount; actual cash
entries cannot change that expectation. Manual reassignment is limited to
pre-pickup custody, requires a reason, and uses the same eligibility checks.
