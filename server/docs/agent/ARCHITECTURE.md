# Assistant architecture

The customer app talks only to `/v1/customer/agent`. The backend admits work as a durable job when a worker heartbeat is present. The worker runs the LangGraph agent, writes ordered events, and emits a generic completion, waiting or failure notification. Cards and totals come from tool results, not model text.

Confirmation drafts are required before an order, cancellation or refund request. Refund requests become support tickets and are then marked executed. Online payment and maps stay unavailable. Wallet top-ups, subscriptions and recipes are not tools.

`purchaseSummary` ranks delivered orders for "my usual". Reorder nudges read the same delivered lines plus active-order variants. The assistant can list offer codes for the current cart; the customer applies an offer in the cart, where checkout validates it. Out-of-stock cards let customers browse alternatives; automatic substitutes are not implemented.

Customers can view archived chats but cannot edit or delete them. Automatic account-erasure and retention workflows are separate. The assistant replies in English for now.

Timing fields must not be treated as a complete latency breakdown: `tool_ms` sums tool handler durations and can overlap, `db_ms` covers only the final message-commit transaction, and `model_ms` remains null until the actual provider calls are instrumented. A failure to record optional timing must not invalidate a completed customer reply.

This document describes the current code. It is not evidence that the phone journey or notifications have been verified.
