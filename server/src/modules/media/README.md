# Media

Provides owner/purpose-bound catalog image and private CSV targets. Client capabilities write staging objects only; registration checks size and type, conditionally copies to a server-only unique final key and validates image magic from the final bytes. Public images use CDN paths or the local image route. Private imports use streamed reads and persisted private reports use authenticated downloads; rider KYC uses its private signed-read port.

Cleanup intents are recorded before external writes and removed transactionally after registration. The worker removes expired staging and abandoned promotions outside database transactions, retaining retries and never deleting final data when commit outcome is ambiguous. Provider failures are mapped to safe application errors. S3 API behavior has SDK contract and emulator coverage; credentialed AWS/CDN acceptance remains an external deployment check.
