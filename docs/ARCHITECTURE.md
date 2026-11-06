# Implemented architecture: P0–P2

The backend is a modular NestJS/Fastify application with one image and six runtime roles. A single audience composition registry drives both route loading and per-audience OpenAPI generation, preventing documentation and runtime routes from drifting apart.

```mermaid
flowchart TD
  HTTP[Customer / rider / store / admin HTTP] --> GUARD[Token, account, role and resource policy]
  GUARD --> MODULES[Identity / config / stores / addresses / serviceability]
  MODULES --> PG[(PostgreSQL + PostGIS)]
  MODULES --> PORTS[Auth / maps / private media ports]
  PORTS --> LOCAL[Local or real adapters]
  PG --> OUTBOX[Leased event delivery obligations]
  OUTBOX --> REDIS[(Redis + BullMQ)]
  REDIS --> WORKER[Idempotent workers]
  WORKER --> PG
```

`domain/` contains pure policy, schedule and value calculations; `application/` contains use cases behind contracts; `infrastructure/` owns SQL and external I/O. Cross-module imports use contracts, with explicit exceptions for Nest module wiring. CI resolves TypeScript imports to enforce this rule. Several identity operations still combine transaction orchestration and persistence in small infrastructure services; the phase implementation does not claim every SQL-bearing service has a separate repository abstraction.

PostgreSQL owns account status/roles, addresses, capacity, state histories, idempotency tombstones and event completion. Redis owns disposable caches/rate limits and job transport. Losing an enqueued Redis job does not complete its durable delivery obligation. The relay can republish it; consumer effects and dedupe commit together.

Workers are enabled only on `all`/`worker`. Identity synchronization preserves per-user operation ordering, reconciles ambiguous provisioning, retries compensation and calls providers outside database transactions. Store availability polling catches up from durable signals. Generic concern queues support bounded concurrency, retry/DLQ replay and IST job schedulers.

Serviceability uses PostGIS `ST_Covers`, explicit zone priority and distance; external maps do not decide zone membership. Confirmed catalog/order/stock/payment workflows are not implemented until P3–P8. Current domain/event contracts prepare those integrations without publishing fake business endpoints.

See the [implementation plan](IMPLEMENTATION_PLAN.md) for the target architecture and the [progress record](PROGRESS.md) for acceptance evidence and remaining provider checks.
