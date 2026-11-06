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
