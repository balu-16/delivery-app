# Customer assistant progress

- A0: Discovery completed; see `DISCOVERY.md` for domain mappings and gaps.
- A1/A2: **Complete.** Configuration, consent, thread/run records, LangGraph model factory (fake, anthropic, bedrock, openai, google, openai_compatible and nvidia with per-provider thinking), read/write/confirm/nudge tools, confirmation drafts with replay/expiry/ownership, token-bounded history middleware, usage accounting. 16 tools; see `TOOLS.md`. ADRs 0002–0004 record the single-agent shape, address flow and draft-blocking decisions.
- A3: **Complete for the approved scope.** Quick order (search → cart → quote → confirmation card → placement through the existing checkout saga), cancellation, refund-request tickets, escalation, order-history "usual", tracking, serviceability, policy text, typed-address parsing with app-screen handoff (ADR 0003). Database-backed placement verified by AWS integration tests.
- A4: **Code complete; Expo Go walkthrough pending.** Text chat, streaming + JSON fallback, EN/HI/TE strings, server-owned cards incl. `refund_confirm`, consent + privacy controls, feature-gated Home entry. Client types regenerated from the exported contract.
- A5 (order support): **Complete** — status/details/tracking reads, cancel with confirmation, refund request, issue tickets, escalation, policy answers.
- A6 (subscriptions): **Intentionally not implemented** (owner decision; existing flag stays off).
- A7 (extras): **Reorder nudges implemented** (opt-in, median-interval sweep, 7-day dedupe, weekly cap, PROMOTIONAL outbox plan with en/hi/te templates). Recipes/substitutions/coupons deferred (ADR 0003).
- A8 (hardening): Prompt-injection canary, cost/token accounting, retention/erasure hooks, kill switches, runbooks in `RUNBOOK.md`; full adversarial suite still grows with the live evals.

## Verification status (17 November 2026)

- Unit: 85 suites / 388+ tests green (fake model, guards, middleware trimming, nudges, provider request shapes, policy).
- Integration on **isolated AWS Aurora** (`AWS_P13_INTEGRATION=yes`, disposable `delivery_p13_*` database): confirmation + nudges suites **12/12 passed**. The earlier Organizations IAM deny no longer applies; `postgres` master IAM works with the `AWS_PROFILE=default AWS_CONFIG_FILE=` override.
- OpenAPI/customer client regenerated; server lint + boundary + manifest checks green; app tests 97/97.
- Live adapter smoke through the real factory: NVIDIA and Google tool calls correct with thinking on; Gemma `thought: true` parts filtered from customer-visible text.
- Live 14-scenario comparison (`pnpm agent:evals:live`) running against both providers; reports land in `artifacts/agent-evals/`.
- Still pending: Expo Go end-to-end on the owner's phone, production migration 050 + `pnpm agent:checkpoints` + grants in a reviewed deployment, and enabling the switches afterwards.

The feature defaults off and must not be enabled for customers until the remaining phases and their tests pass.
