# 0009: Cart intent and placement uniqueness

Date: 6 November 2026. Status: accepted for P5/P6 implementation.

## Context

Two tabs (or a retry with a different HTTP idempotency key) must not place the same cart state twice. The P0 idempotency framework deduplicates per (actor, method, resource, key), which cannot help when the keys differ. D15 requires an atomically consumed cart-version checkout intent with a unique placement reference.

## Decision

A quote confirmation issues a checkout intent bound to (cart, cart version, quote). The placement transaction consumes the intent atomically: the intent row transitions from `ISSUED` to `CONSUMED` under row lock with a partial unique index guaranteeing one consumption, so a second placement attempt with any idempotency key fails with `CART_INTENT_CONSUMED` until the client obtains a new quote and intent. The quote snapshot is validated inside the same transaction (version, expiry, config and price versions, coupon fingerprint), keeping commercial versions and the intent consumption in one commit boundary with stock, coupon, wallet and order effects.

HTTP `Idempotency-Key` on `POST /checkout/place` remains the transport-level replay guard for the identical request; the intent is the business-level guard for the identical cart state. Neither substitutes for the other.
