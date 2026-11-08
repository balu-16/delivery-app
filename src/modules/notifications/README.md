# Notifications (P9)

Event-matrix consumer, localized templates, per-channel delivery records,
device tokens, preferences and the in-app inbox. SMS is an explicitly
disabled capability.

## Invariants

- Failures never roll back producer work: the outbox consumer writes DB rows
  only inside `consumeOnce`'s transaction; provider calls happen afterwards
  in the `deliver` concern handler or the recovery scan.
- Dedupe key = `recipient|channel|eventType|aggregateId|transitionVersion`.
  Replayed events insert one logical notification (`ON CONFLICT DO NOTHING`);
  a distinct transition version notifies again (ADD-20).
- Unknown event types are ignored. Malformed known events and unsupported schema versions are recorded in `notification_event_errors`.
- Promotional quiet hours (IST, default 21:00–08:00, `app_config`
  `notificationQuietHoursStart/End`) hold only `PROMOTIONS`-class sends and
  release them at window end; transactional messages are never held or disabled by promotional preferences.
- Device tokens are unique: a token seen for another user is reassigned on
  registration; FCM invalid-token results deactivate the registration.
- Bounded batches (≤500 tokens per multicast), per-token results, timeouts
  on every provider call, bounded attempts with jittered backoff
  (`MAX_DELIVERY_ATTEMPTS`), then FAILED (admin-visible). Sends are
  at-least-once: a timeout after provider acceptance may still deliver;
  no exactly-once external claim. `ambiguous_sends` records expired provider leases and send errors; notification IDs are stable client message and collapse IDs.
- Payloads carry IDs and deep links only; inbox ownership is filtered inside
  every SQL statement (other users' ids return 404).

## Events consumed (consumer name `notifications`)

Handled: `ORDER_CONFIRMED`, `picking.task_changed` (IN_PROGRESS → picking),
`ORDER_PACKED` (packed), `picking.item_changed` (short/substituted), `picking.sla_breached`,
`inventory.low_stock`, `inventory.expiry_soon`, `dispatch.no_rider`,
`delivery.failed`, `ORDER_OUT_FOR_DELIVERY`,
`ORDER_DELIVERED`, `ORDER_CANCELLED`, `payments.funding.failed`,
`payments.refund.settled`, `payments.topup.captured`,
`rider.offer_created|revoked`, `rider.document.approved|rejected`
(tolerant), `reconciliation.finding`. Recipients resolve from payload IDs
with an `orders.user_id` fallback; store alerts go to store managers and
ops alerts to active admins. Unknown events and intentional internal transitions are skipped; malformed known notification events and unsupported schema versions are recorded in `notification_event_errors`.

## Configuration

`notificationQuietHoursStart` / `notificationQuietHoursEnd` (minute-of-day
IST, safe defaults 1260/480) are read from `app_config` through typed `AppConfig`; missing keys use typed defaults and invalid values or database errors propagate.

## Firebase push and manual campaigns

Set `PUSH_PROVIDER=fcm` and provide exactly one of `FIREBASE_SERVICE_ACCOUNT_PATH` (a mounted service-account JSON file) or `FCM_SERVICE_ACCOUNT_JSON_SECRET` (the JSON contents). Never commit either credential. The client registration and the service account must belong to the same Firebase project. The backend accepts the existing `token` and `platform` registration fields plus optional `identifierType`, `FCM_TOKEN` by default; current web Firebase installation IDs must use `FID`, and native Android FCM registration tokens use `FCM_TOKEN`. The application must obtain and refresh these identifiers and handle foreground messages, permissions, clicks and its web service worker; none of that client code is supplied here.

Admins and super admins can call `/v1/admin/push-campaigns/preview`, `POST /v1/admin/push-campaigns`, `GET /v1/admin/push-campaigns`, and `GET /v1/admin/push-campaigns/:id`. Creation requires an `Idempotency-Key` header. Requests contain `target` with `mode` (`ALL`, `USERS`, or `PLATFORM`), `apps` (one or more of `CUSTOMER`, `RIDER`, `STORE`, `ADMIN`) and, as applicable, `userIds` or `platform` (`WEB` or `ANDROID`). The `kind` is `PROMOTIONAL` or `OPERATIONAL`. Creation also accepts `title`, `body`, optional `clickAction`, `imageUrl`, and string-valued `data`. An identical key and request replays the campaign; reusing the key with a different request fails. A recipient snapshot is limited to 10,000 registrations. Promotional campaigns respect opt-outs and quiet hours. Per-device status `SENT` means FCM accepted the message, not that a device displayed it.
