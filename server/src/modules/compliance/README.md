# Maker-checker compliance

Provides the reusable approval executor for registered actions.
An action registry fixes the maker and checker roles, payload validator, version and expiry.
Requests store a canonical payload hash and an independent unique execution key.
Approval locks identity changes and the request before checking current maker and checker authorization.
The checker must differ from the maker; expired, altered or policy-version-mismatched requests cannot execute.
The action, execution state and audit record commit in a single transaction.
Action handlers must keep external effects outside the transaction and use durable obligations.
Identity role changes use the executor and serialize with last-super-admin protection.
Evidence: `test/unit/identity/approval-policy.spec.ts` and `test/concurrency/identity`.

## Privacy and operations

Customer erasure requests and approved workforce requests are rechecked against live obligations while holding the account lock. Local authorization is revoked before the identity provider is disabled; the erased identity retains its opaque pool and subject as a bootstrap tombstone. Cleanup remains pending until provider synchronization, fenced private media and private exports have finished. Legal holds and unpaid or active obligations block erasure. Financial records and operation deduplication references remain retained.

Reports and personal-data exports run as durable jobs. Each attempt reads a bounded repeatable-read snapshot, writes a temporary CSV, and then streams it to private storage. Downloads require the current owner and audience; expired and abandoned files are removed asynchronously. Report and erasure workers log fixed failure categories without provider payloads or personal information. Fraud rules create advisory signals for review; they do not change account, order or payment state. Retention removes expired notification payloads and idempotency response bodies while keeping their deduplication records.

Evidence: `test/integration/compliance`, `test/e2e/p12-compliance.spec.ts`, and `test/unit/compliance`.
