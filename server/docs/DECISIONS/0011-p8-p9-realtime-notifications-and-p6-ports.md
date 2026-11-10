# 0011: P8/P9 realtime and notification foundations, and P6 integration ports

Date: 7 November 2026. Status: accepted for P8/P9 implementation.

## Context

P8 (riders, dispatch, tracking, delivery, COD, earnings) and P9 (notifications) run in parallel while P6's orders/checkout/invoicing slice is still in flight. P6's payments and wallet contracts are complete and stable, but there is no orders module, no `ORDER_CONFIRMED` producer, no delivery-code port, no COD contract and no invoicing. P0 deliberately left Socket.IO unproven beyond role loading, and no email/push adapters exist.

## Decision

**Dependencies.** `socket.io`, `@socket.io/redis-adapter` (runtime) and `socket.io-client` (dev) serve realtime; `nodemailer` serves SMTP, `@aws-sdk/client-sesv2` serves SES, `firebase-admin` serves FCM. Each new dependency follows the Section 4 rule: smallest viable client, adapter isolation, fake/local adapters selected by env for local development.

**Realtime ownership.** The Socket.IO server bootstrap is platform infrastructure (`src/platform/realtime`), owned by the main agent: one server attached to the existing Fastify instance, Redis adapter for multi-instance fan-out, per-audience namespaces (`/rider`, `/customer`) created only for roles that own the audience, handshake authentication through the existing `TOKEN_VERIFIER`, a room-authorization callback per namespace, a connect-snapshot hook, and graceful close drained before Redis and database shutdown. Phase modules consume namespace factories through platform contracts and never construct their own servers.

**P8 over P6 gaps (mirrors ADR 0010).** Dispatch creates delivery tasks from the `ORDER_CONFIRMED` outbox event with the exact payload recorded in `picking/contracts/fulfillment.ts`; until P6 produces it, tests emit fixture events and live consumers stay inert. P8 owns the `DeliveryCodes` port over 007's `order_code_verifiers` table (D20 derivation/verification, durable attempt limits, production secret) so the rider `deliver` flow is real; P6's confirmation flow calls `issue` once it exists. Order delivery transitions (`markDelivered`, `markDeliveryFailed`) are consumer-defined ports bound to P6 when it lands — fail-closed `DISPATCH_DEPENDENCY_UNAVAILABLE` (503) with transaction rollback, so custody and money never diverge. Dispatch exports `DeliveryTaskCancellation` for P6's shared cancel routine, mirroring `PICK_CANCELLATION`. COD collection records through 007's `cod_collections`; `cod_settlements` belongs to P8's migration. Earnings are computed exactly once per delivered task from configuration.

**Event schema agreement (cross-phase).** Producers declare outbox consumers at emit time:

- `ORDER_CONFIRMED` → consumers `['dispatch','picking','notifications']` once P6 produces it (picking's consumer name is committed).
- `picking.task_changed` / `picking.task_completed` (P7, additive change in this phase) → `['dispatch','notifications']`; dispatch uses `status='IN_PROGRESS'` for the `ON_PICK_START` trigger.
- P8 emissions (`dispatch.no_rider`, `delivery.task_assigned`, `delivery.completed`, `delivery.failed`, rider document review outcomes) → `['notifications']`.
- P6's `payments.funding.*`, `payments.topup.captured`, `payments.refund.settled` gain `'notifications'` in their consumers arrays as a minimal integration edit.
- P9 registers one `notifications` consumer; event types outside its matrix are skipped, never failed.

**Notifications.** Dedupe key = recipient + channel + event type + transition version, so replayed events produce one logical notification while distinct transitions notify again. Provider calls happen only after commit through the `notifications` BullMQ concern; retries are durable with jitter; ambiguous provider sends are at-least-once with stable message identity (no exactly-once external delivery claim). Promotional quiet hours apply in IST and never to transactional messages. SMS stays an explicitly disabled adapter.

## Consequences

- All roles boot with P8/P9 before P6's orders module lands; delivery and money transitions fail closed instead of being approximated.
- Redis GEO membership alone never proves rider eligibility; fresh state is revalidated under locks at assignment.
- Live SES/FCM/Ola acceptance and load testing remain owner-run activation steps and are never claimed by local suites.
