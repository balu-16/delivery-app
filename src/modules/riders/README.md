# Riders (P8 rider operations, cash, COD records, earnings)

Operational rider state for last-mile delivery: going online/offline (shifts),
heartbeats, inactivity/auto-offline sweeps, task capacity, the cash-in-hand
ledger, COD collection records (007 `cod_collections`) and per-task earnings.
Profile approval and KYC stay in P1 (`rider_profiles`); this module reads them
read-only for eligibility.

## Invariants

- Going online requires an `APPROVED` profile; suspension rejects with
  `RIDER_SUSPENDED`. Going offline with active tasks keeps custody — dispatch
  owns the re-dispatch/escalation decision (D21).
- Cash-in-hand is an append-only ledger (`balance_after` ≥ 0); deposits cannot
  push it negative — an over-deposit records a discrepancy, which is audited.
- COD collection upserts `cod_collections` per order; a collected amount that
  differs from the settled expected COD amount is flagged, and the dispatch
  deliver flow refuses automatic completion for mismatched COD (PAY-09).
- Earnings are computed exactly once per delivered task (`UNIQUE(task_id)`)
  from pure configuration (base + distance + detention + tip).

## Events

Emits `riders.cash_deposited` → consumers `['notifications']`.

## Dependencies

Reads P1 `rider_profiles`/`users` read-only for eligibility revalidation
(D22: Redis GEO membership never proves eligibility). Dispatch consumes
`RIDER_ELIGIBILITY`; cash, capacity and earnings settings use typed `app_config` reads.
Invalid configuration propagates rather than silently replacing it.
