# Stores

Owns legal entities, cities, stores, hours, holiday overrides and delivery zones.
Current role/store assignments are authorized inside mutation transactions.
Zone geometry is valid, bounded by the city and versioned for cache invalidation.
Overnight hours and closing buffers are evaluated for the requested IST slot.
Capacity claims serialize under a store lock and refresh the current configured limit.
Manual and signal-driven pause changes preserve audit/history/events.
No-rider pause signals are reevaluated by worker/all startup and periodic polling.
A pause blocks new availability without cancelling future in-flight order integrations.
Evidence: real PostGIS serviceability, capacity, scheduler and permission tests.
