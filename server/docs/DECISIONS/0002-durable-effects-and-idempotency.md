# 0002: Durable effects, idempotency and post-lock time

Date: 6 November 2026. Status: accepted for P0 implementation.

## Context

Retries can arrive after cached responses expire. Redis can lose a job after the relay records successful enqueue. A transaction may wait across a business cutoff. These cases must not create duplicate money/stock effects or stale-time decisions.

## Decision

Keep the scoped idempotency key, request hash and original operation ID after deleting its cached response. Claim and execute with an owner token; lock and revalidate the row before mutations. The mutation and completed response commit in the same transaction. After response pruning, return the original operation reference/expired-response outcome rather than executing again; changed payload still conflicts.

Persist a separate outbox delivery obligation for each event/consumer. Enqueue acknowledgement is distinct from effect completion. Claim in a short DB transaction, publish outside it, then acknowledge under a matching lease token. Retry every uncompleted obligation, including after Redis loss. Consumer dedupe/effects/completion commit together. Use bounded failure/dead-letter state and audited replay through the same handler.

Sample `clock_timestamp()` after required locks; pass that one value to pure decision rules. Transaction-start `now()` cannot establish whether a cutoff has passed during a lock wait.

## Consequences

Transport remains at least once; local effects can be unique through transactional dedupe and business keys. External effects require their own durable operation and provider-specific idempotency/reconciliation. Tombstone retention and permitted replay/erasure behavior need a documented retention policy as later compliance modules land. Tests must exercise stale owners, response pruning, publish/ack crashes, enqueue loss and post-lock time.
