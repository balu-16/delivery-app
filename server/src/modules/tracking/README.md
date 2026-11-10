# Tracking (P8 GPS ingest, GEO index, ETA)

Location pipeline for last-mile visibility: batched GPS ingest with a pure
integrity gate (mock GPS, poor accuracy, teleports, future skew, duplicates,
out-of-order points), Redis GEO + freshness hash updates, monotonic sampling
into the daily-partitioned `rider_location_history`, and the v1 ETA provider
(haversine × road factor ÷ average speed, published as a range).

## Invariants

- The rider status row is the freshness authority: ingest only ever advances
  `last_location_at` (timestamp ordering is atomic across instances — ADD-19),
  so Redis GEO membership alone never proves eligibility (D22/ADD-17).
- History rows are sampled (≥ configured seconds OR ≥ configured metres since
  the last persisted point) and partitions are created ahead of midnight and
  dropped after the retention window (ADD-19).
- Rider location is published to `order:{id}` rooms throttled to ≥ 3s and only
  while the task is inside the visible custody window; dispatch owns that
  mapping through the `ACTIVE_ORDER_RESOLVER` holder (no module cycle).

## Events

Publishes socket events only (`rider.location` on `/customer`); no outbox
events. Emits nothing to consumers.

## Dependencies

Consumes typed `APP_CONFIG` settings and platform Redis.
Worker publications pass through Redis to each audience instance; each
instance forwards locally so Socket.IO does not fan out the same publication twice. Dispatch consumes
`RIDER_GEO`, `RIDER_LOCATION_READS` and `ETA_PROVIDER`.
