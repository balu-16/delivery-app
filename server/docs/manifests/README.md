# Requirement and evidence manifests

Each manifest has `schemaVersion: 1` and an `items` array. An item's stable ID, source section, phase and status describe the requirement. `planned` means no completion claim; `implemented` means code exists; `verified` requires linked test files and recorded passing evidence. Fixture testing is distinct from live-provider acceptance.

The 34 `SRC-*` requirements describe entire source sections and stay planned while those broad requirements span later phases. Separate local acceptance records describe the bounded checks verified during this implementation; they do not assert hosted CI or whole-project completion.

`operations.json` records the chosen canonical API paths. Generic CRUD aliases proposed during planning are not extra API requirements: equivalent list/update/action paths are documented once. P0–P12 runtime operations use their canonical implemented paths, including subscriptions, support, payouts, reports and cross-domain erasure. Phase acceptance is recorded in PROGRESS.md; code and exported routes alone do not establish acceptance. S3 adapter code and local contracts are implemented; credentialed AWS/CDN activation is recorded separately.

`scripts/verify-manifests.mjs` validates shape, uniqueness and test links. After OpenAPI export, it compares the complete implemented route set against all four audience documents. CI runs the comparison after export so a clean checkout cannot silently skip that check.

`local-operations.json` documents development-only token/media capabilities, which do not belong in the four production audience documents. `env.json` contains names/defaults and redaction metadata, never deployment secrets. The full Section 34 case and Section 12 invariant register remains in EDGE_CASES.md.
