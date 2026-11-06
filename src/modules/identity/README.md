# Identity

Owns customer and workforce identity, current account state, roles, assignments, onboarding and provisioning.
Cryptographic verification precedes the current PostgreSQL account and role checks on every request.
Workforce permissions are the intersection of current local roles and verified token groups.
Pending riders may submit onboarding information but do not satisfy approved-rider policies.
Role and account mutations serialize with the last-super-admin check and write audit, history and synchronization obligations atomically.
Provider calls run outside database transactions; provisioning uses a stable username, a lease, and durable compensation retries.
A per-user ordered worker applies provider state changes, including password reset; retries are at least once.
Local private KYC uploads use short-lived scoped capabilities; production private storage remains a separate provider integration.
Erasure requests are recorded idempotently; cross-domain eligibility and anonymization belong to P12.
Evidence: `test/unit/identity`, `test/integration/identity`, and `test/concurrency/identity`.
