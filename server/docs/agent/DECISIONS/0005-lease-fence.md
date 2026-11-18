# Lease fence and stopped runs

A background job renews its lease and watches `cancel_requested`. The worker carries its job ID and lease token through its asynchronous execution. Cart, draft decisions, support and order commits lock and verify that exact job and token in the transaction. Stop, expiry, recovery, or a changed token blocks the old worker. Completion also verifies the lease. Recovery does not replay interrupted work.

A card action is refused while the same thread has a queued or running job.

If Stop arrives after a transaction has already acquired the commit lock, that transaction may finish before Stop takes effect. Stop does not reverse a committed order, cancellation or refund request. A refund ticket that was already created must still be recorded against its draft even after Stop.
