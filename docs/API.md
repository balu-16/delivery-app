# Current API contracts

Run `pnpm openapi:export` to generate and validate four OpenAPI 3.1 documents in `openapi/`. Development docs are available under `/v1/{customer|rider|store|admin}/docs` for enabled audiences. Production docs are disabled. The [operation manifest](manifests/operations.json) records the canonical implemented paths, permissions and evidence; future-phase entries remain explicitly planned.

Authentication uses audience-bound access tokens. Customer bootstrap alone accepts an ID token. A token from the wrong pool/client/audience is rejected with 401; an authenticated wrong role is rejected with 403; owner/store-scoped resource reads do not reveal another actor's records. Local `/dev/auth/token` and signed private-media capability routes are excluded from production API documents.

Requests use camelCase JSON and bounded, whitelist-only DTOs. Administrative lists use bounded cursor pages; the customer's address list is bounded by its configured address limit. Unknown DTO fields are rejected. Personal responses have `Cache-Control: no-store`. `X-Request-Id` is generated or validated, returned to clients and used as the problem response's trace ID.

Errors have content type `application/problem+json` and fields `type`, `title`, `status`, `code`, `detail`, `traceId`. Declared application codes survive serialization; arbitrary vendor messages, SQL and credentials do not. Relevant examples include `INVALID_TOKEN`, `PROFILE_NOT_INITIALIZED`, `ACCOUNT_DISABLED`, `RIDER_NOT_APPROVED`, `LAST_SUPER_ADMIN`, `APPROVAL_INVALID`, `CONCURRENT_MODIFICATION`, `ADDRESS_NOT_FOUND`, `RESOURCE_CONFLICT`, and `RATE_LIMITED`.

HTTP body/transport errors use the same envelope. Rate limits return `Retry-After`; ordinary requests fail open with a warning if Redis limits cannot be checked, while location ingestion is configured to fail closed. Per-actor limits run only after cryptographic identity verification; a broader per-IP limit protects anonymous ingress.

The idempotency primitive scopes a key to actor/audience/method/resource, hashes normalized input and fences active execution. Completed cached responses are replayed; changed input conflicts. Compact operation references remain after response pruning. Future money/stock endpoints must use this primitive plus their durable business-reference constraints.

Money in future commerce contracts is integer paise serialized as decimal strings, never JSON floating point. Time is UTC in storage and IST for business windows. P0–P4 expose catalog/search and stock operations. Checkout, payments, delivery tracking and subscriptions remain later-phase work.

Catalog administration uses `/v1/admin/catalog`; customer catalog/search derives store scope from an owned `addressId` or the default address. An omitted/null price `validFrom` activates at database time after locks. Past requested starts activate at that time without backdating; future starts retain their schedule. Catalog responses use private revalidation with ETags. Local image/capability routes are documented separately from the four audience APIs.

Store stock effects require `Idempotency-Key` (1–150 characters), scoped to actor/store/operation and checked against canonical input. Receipt/quality/approval writes return an empty 201; count/adjustment returns `{}` or `{approvalId}` with identical replay. Administrative stock approval also requires a current store-manager assignment and a checker different from the maker. Error codes include `INVALID_QUANTITY`, `INVENTORY_INSUFFICIENT`, `INVENTORY_RESERVED`, `BATCH_NOT_ELIGIBLE`, `RESERVATION_STATE_INVALID`, `PRODUCT_NOT_PUBLISHABLE`, `INVALID_SEARCH_QUERY`, `APPROVAL_REQUIRED` and `REPORT_NOT_READY`.
