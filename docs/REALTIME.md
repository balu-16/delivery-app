# Realtime contract

Socket.IO uses `/socket.io` with the `/customer` and `/rider` namespaces. Customer and rider application roles expose their own namespace; `all` exposes both. Admin, store and worker roles expose neither. Use a compatible Socket.IO client rather than a raw WebSocket client.

Supply an access token in the handshake's `auth.token` field. Customer tokens require the customer audience/pool; riders require the rider audience, active workforce account and current RIDER role. Connections are revalidated and expired tokens disconnect. Reconnect obtains a fresh authoritative snapshot. Applications must refresh credentials through their identity provider and reconnect; a socket does not renew an access token.

Each connection automatically joins its own `user:<userId>` room. To request an order room, emit `subscribe` with `{ "room": "order:<orderId>" }`. Customers may subscribe only to their own active delivery task. Riders must hold the assigned task in ASSIGNED, AT_STORE, PICKED_UP or ARRIVED. Emit `unsubscribe` with the same room shape to leave. Rooms are rechecked against current authorization. Room requests are bounded; arbitrary client business events receive `rejected` with `REALTIME_RECEIVE_ONLY`. Business commands remain HTTP operations with their normal authorization and idempotency rules.

Connection caps default to ten connections per account per namespace and 10,000 per namespace on each process. `SOCKET_MAX_CONNECTIONS_PER_USER` and `SOCKET_MAX_CONNECTIONS_PER_NAMESPACE` configure these bounds. They count active connections and authenticated pending handshakes and release slots on disconnect. These are per-instance limits; replica totals need an ingress capacity policy. They do not replace authentication or per-request abuse controls.

| Server event | Recipient and payload |
|---|---|
| `snapshot` | Customer: `{ orders: [{ orderId, status, riderLocation, eta }] }`, bounded to 20 active tasks. Rider: `{ offers, currentTask }`, using the same task/offer views as HTTP. |
| `offer.created` | Rider's user room; new offer identifiers, task and expiry from dispatch. |
| `offer.revoked` | Rider's user room; `{ offerId, taskId, reason }`. |
| `task.updated` | Affected rider's user room; task/order identifiers and current dispatch state. |
| `order.status` | Customer order room; current status or `RIDER_REDISPATCH`. |
| `eta.updated` | Customer order room; estimated delivery range from the current task. |
| `rider.location` | Customer order room; `{ lat, lng, at, accuracyM, speedMps }`. Publishing is throttled to at most one update per three seconds per order on a publisher instance. |
| `rejected` | Requesting socket; a fixed error code such as UNAUTHORIZED, FORBIDDEN, RATE_LIMITED, INVALID_ROOM or REALTIME_RECEIVE_ONLY. It does not grant room membership. |

Socket delivery is transient. Workers publish through Redis and each audience instance forwards to its local sockets. Disconnects and Redis interruptions can lose updates; clients must reconcile through the snapshot and authenticated HTTP task/tracking endpoints. Terminal task states stop location publication and remove the task from current snapshots. Consumers should use identifiers and current state to tolerate duplicate or delayed events rather than infer durable business completion from event arrival.

The implementation evidence includes platform socket tests, worker-to-two-instance broadcasting and role-specific dispatch tests. P13 adds revocation/reconnect and load evidence; consult PROGRESS.md for actual acceptance rather than inferring it from this contract. Redis transport is not a durable event journal. No contact details, delivery codes, payment credentials or provider secrets belong in realtime payloads.
