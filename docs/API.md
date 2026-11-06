# Current API contracts

Run `pnpm openapi:export` to generate and validate four OpenAPI 3.1 documents in `openapi/`. Development docs are available under `/v1/{customer|rider|store|admin}/docs` for enabled audiences. Production docs are disabled. The [operation manifest](manifests/operations.json) records the canonical implemented paths, permissions and evidence; future-phase entries remain explicitly planned.

Authentication uses audience-bound access tokens. Customer bootstrap alone accepts an ID token. A token from the wrong pool/client/audience is rejected with 401; an authenticated wrong role is rejected with 403; owner/store-scoped resource reads do not reveal another actor's records. Local `/dev/auth/token` and signed private-media capability routes are excluded from production API documents.

Requests use camelCase JSON and bounded, whitelist-only DTOs. Administrative lists use bounded cursor pages; the customer's address list is bounded by its configured address limit. Unknown DTO fields are rejected. Personal responses have `Cache-Control: no-store`. `X-Request-Id` is generated or validated, returned to clients and used as the problem response's trace ID.

Errors have content type `application/problem+json` and fields `type`, `title`, `status`, `code`, `detail`, `traceId`. Declared application codes survive serialization; arbitrary vendor messages, SQL and credentials do not. Relevant examples include `INVALID_TOKEN`, `PROFILE_NOT_INITIALIZED`, `ACCOUNT_DISABLED`, `RIDER_NOT_APPROVED`, `LAST_SUPER_ADMIN`, `APPROVAL_INVALID`, `CONCURRENT_MODIFICATION`, `ADDRESS_NOT_FOUND`, `RESOURCE_CONFLICT`, and `RATE_LIMITED`.

HTTP body/transport errors use the same envelope. Rate limits return `Retry-After`; ordinary requests fail open with a warning if Redis limits cannot be checked, while location ingestion is configured to fail closed. Per-actor limits run only after cryptographic identity verification; a broader per-IP limit protects anonymous ingress.

The idempotency primitive scopes a key to actor/audience/method/resource, hashes normalized input and fences active execution. Completed cached responses are replayed; changed input conflicts. Compact operation references remain after response pruning. Future money/stock endpoints must use this primitive plus their durable business-reference constraints.

Money in future commerce contracts is integer paise serialized as decimal strings, never JSON floating point. Time is UTC in storage and IST for business windows. P0–P2 do not expose checkout, payments, catalog, delivery tracking or subscriptions yet.
