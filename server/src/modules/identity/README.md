# Identity

Owns customer and workforce identity, current account state, roles, assignments, onboarding and provisioning.
Cryptographic verification precedes the current PostgreSQL account and role checks on every request.
Every protected audience requires exactly one matching application group in the verified token and one current database role. The roles are CUSTOMER, RIDER, STORE_MANAGER, SUPPORT_AGENT and SUPER_ADMIN; ADMIN and PICKER are retired.
When both configured Cognito pool IDs are the same, each client is still verified separately and one Cognito subject cannot become two local identities. The client ID never grants a privileged role. Shared-pool provisioning uses email usernames, refuses to adopt an existing provider identity, and never deletes an identity as compensation. A lost create response is resolved as a manual-review conflict rather than guessing ownership. Provider-level disable, delete, and reset operations affect the shared Cognito identity and must be accounted for by operators. Confirmed customer and rider signups are queued for their respective groups, with retry and conflict checks; see the group synchronization guide.
Pending riders may select a store and submit onboarding information but do not satisfy approved-rider policies. Only an active manager assigned to the selected store can review their documents.
Role and account mutations serialize with the last-super-admin check and write audit, history and synchronization obligations atomically.
Provider calls run outside database transactions; provisioning uses a stable username, a lease, and durable compensation retries.
A per-user ordered worker applies provider state changes, including password reset; retries are at least once.
Local private KYC uploads use short-lived scoped capabilities; production private storage remains a separate provider integration.
Erasure requests are recorded idempotently; cross-domain eligibility and anonymization belong to P12.
Evidence: `test/unit/identity`, `test/integration/identity`, and `test/concurrency/identity`.
