# 0007: Payment gateway contracts and HTTP client choice

Date: 6 November 2026. Status: accepted for P6 implementation.

## Context

P6 needs a gateway port with fake and Razorpay providers. Razorpay documents its Orders API, webhook signatures over the raw body, and the `X-Refund-Idempotency` header for refunds. The `receipt` field on a Razorpay order is a merchant reference echoed back by the API; it is not a gateway-side idempotency guarantee, so a lost create response can still produce two gateway orders. No Razorpay SDK dependency existed in P0–P4 and the dependency list is deliberately small.

## Decision

`PaymentGatewayPort` exposes `createOrder`, `verifyCheckoutSignature`, `verifyWebhook`, `fetchPayment`, `refund`, `fetchSettlements`. The Razorpay adapter is implemented with the built-in `fetch` client; no vendor SDK is added. Amounts are converted to paise integers and validated for safe-integer range before any SDK-style number conversion; currency is compared to the order currency before acceptance.

Every create/refund is a durable operation with a stable correlation reference persisted before the call. A lost create response is recovered by the documented lookup path (order list/filter by receipt + amount); zero matches, or multiple distinct matches, leave the operation UNKNOWN and route it to reconciliation or manual review — never a speculative second create. Refunds send the documented `X-Refund-Idempotency` header carrying the durable refund operation reference. Webhook signatures are verified over the exact raw request body using the configured secret, and the raw payload is persisted in the inbox before processing.

The fake gateway is deterministic: it records requested operations and produces configurable captured/failed/unknown outcomes, webhook-before-response, duplicates and amount mismatches for tests. Production boot rejects `PAYMENTS_PROVIDER=fake` and Razorpay test keys (`rzp_test_`), enforced by the existing environment schema.

Tax treatment of fees and wallet legality are configurable business rules, not code constants; they require owner review with a chartered accountant / PPI counsel before production activation. This ADR records the engineering requirement, not legal approval.
