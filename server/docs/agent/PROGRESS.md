# Customer assistant progress

- A0: Discovery completed; see `DISCOVERY.md` for domain mappings and gaps.
- A1/A2: In progress. Configuration, consent, persistent thread/run records, the LangGraph model factory, read tools and cart/support tool foundations have been added. Skill routing, token-bounded history, and several requested tools remain.
- A3: In progress. Order and cancellation confirmation paths have been added and their graph interrupt has a focused fake-model test. Database-backed placement, concurrency, recovery, and the typed-address continuation remain unverified or incomplete.
- A4: In progress. The text chat, localization, stream parser, cards, Home entry, and privacy controls have been added; the end-to-end flow has not yet been validated in Expo Go.
- A5–A8: Not complete. Refund confirmation, subscription actions, nudges, full evaluations and launch hardening remain.

AWS Lambda checks passed for server TypeScript, the 13 focused assistant unit cases, server lint and boundary/manifest validation. Customer-app TypeScript, the SSE parser cases and lint on the changed app files also passed. Full customer-app lint still reports existing errors in other test and script files. Aurora/Valkey integration is blocked by an AWS Organizations explicit deny on IAM connections; no isolated database was created. See `HANDOFF.md` for the remaining checks and operational prerequisites.

The feature defaults off and must not be enabled for customers until the remaining phases and their tests pass.
