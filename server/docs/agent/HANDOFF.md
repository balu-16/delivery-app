# Customer assistant handoff (work in progress)

The assistant is not ready to enable or deploy. Both `AGENT_ENABLED` and the remote `agent_enabled` flag default off. No production migration, native build, or EAS build has been applied for this work. Model credentials live only in the git-ignored `server/.env` (0600) and must be rotated before any production use.

## What is present

- Customer chat and streaming client (English/Hindi/Telugu), server-owned cards incl. `refund_confirm`, consent + privacy controls, feature-gated Home entry.
- Pinned LangChain/LangGraph runtime: prebuilt agent, Postgres checkpointer, interrupt/resume confirmations, `trimMessages` history window, model fallback middleware, provider factory for fake/anthropic/bedrock/openai/google/openai_compatible/nvidia with per-provider thinking (`LLM_THINKING`; NVIDIA `chat_template_kwargs.enable_thinking`, Google `thinkingLevel=high`, OpenRouter via `OPENROUTER_REASONING`).
- 16 customer tools wrapping existing domain use-cases (see `TOOLS.md`): shopping, cart, addresses (parse + app-screen handoff), checkout/cancel confirmations, refund requests, escalation, tracking, serviceability, policy text, wallet, nudge opt-in.
- Reorder-nudge worker (opt-in, weekly cap, dedupe) registered for the worker role; notification templates in migration `051`.
- Migrations `050` (agent schema + `thinking_tokens`) and `051` (templates); checkpoint setup script; runtime grants script. **Not applied to the application database.**

## Verification already done (17 November 2026)

- Unit 388+ green; AWS integration suites (confirmation + nudges) 12/12 on a disposable Aurora fixture; OpenAPI + client types regenerated; server lint/boundary/manifest and app tests green.
- Live factory smoke for NVIDIA and Google with thinking on (synthetic prompt only); Gemma thinking parts verified filtered from customer-visible text.

## Work required before launch

1. **Expo Go end-to-end on the owner's phone** (server on :13080 with the switches enabled locally, synthetic customer). Only after that test and the owner's explicit approval may a native or EAS build start.
2. Review the live-eval reports in `artifacts/agent-evals/` and pick the production provider/model; rotate both provider keys before enabling anything beyond testing.
3. In a separately reviewed deployment: apply migration `050` + `051`, run `pnpm agent:checkpoints` with the migration identity, apply `pnpm grant:runtime`, confirm backup/rollback/retention, then set `LLM_PROVIDER`/`LLM_MODEL`/`LLM_THINKING` and enable `AGENT_ENABLED` + the remote `agent_enabled` flag.
4. Confirm the chosen provider's data-retention terms before real customer traffic (NVIDIA trial terms restrict production use; Google free tier may reuse prompts).
5. Remaining hardening backlog: adversarial eval growth (Section 20 items in `EDGE_CASES.md` marked ⏳), nudge "ignored" auto-stop, client resync validation, retention/erasure integration pass.

## AWS test notes

The old Organizations deny on IAM database/cache connections no longer applies for the current identity. Aurora master IAM requires the `AWS_PROFILE=default AWS_CONFIG_FILE=` override; the restricted `delivery-runtime` profile still only holds `rds-db:connect` for `delivery_runtime`. Tests always use disposable `delivery_p13_*` databases and synthetic data — never the real customer tables.
