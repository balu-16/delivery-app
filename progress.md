# DairyDirect customer assistant — progress and handoff

Last updated: 17 November 2026 (implementing session). This file records the customer-assistant work in `customer-app-agent-prompt.md`; it is not a claim that the entire DairyDirect project is complete.

## Current status

**Owner-approved scope (17 November 2026):** complete shopping, addresses, cart, COD + existing wallet balance, order tracking, cancellations and support; keep reorder nudges; do **not** implement subscriptions or recipes; no wallet top-up; maps and online payments stay marked under development. Then compare NVIDIA Nemotron 3.5 Super VL vs Google Gemma 4 26B A4B (both with thinking) on ~12 synthetic scenarios each; commit agent work incrementally; test in Expo Go before any native/EAS build.

**Done this session (committed):**
- Phase 0 verified: AWS identity (IAM user `notifications`), Aurora available (`delivery_runtime` via IAM; `postgres` master via IAM with the `AWS_PROFILE=default AWS_CONFIG_FILE=` override), ElastiCache serverless `delivery-app` reachable (PONG).
- Phase 1 committed (`feat(agent): customer assistant foundation with NVIDIA/Google thinking wiring`): prior uncommitted foundation + `nvidia` provider (`chat_template_kwargs.enable_thinking`), `LLM_THINKING` switch (nvidia/google only), Google `thinkingLevel=high`, `messageDeltaText` guard so thinking/thought parts never reach customers, 9 new unit tests. Full unit suite green (364 tests), server typecheck clean.
- **Live adapter smoke passed through the real factory** (the previously unverified item): NVIDIA returned the correct synthetic tool call with reasoning tokens tracked separately; Google returned the correct synthetic tool call; Gemma emits thinking as `thought: true` text parts — now filtered.

## Next
- Phase 6: live model comparison running (`pnpm agent:evals:live --provider nvidia|google`) — 14 scenarios each on the isolated AWS fixture.
- Phase 7: Expo Go end-to-end. Phase 8: final report and handoff.

## Phase 5 verified (17 November 2026)
- **AWS integration PASSED**: `test/integration/agent/confirmation.spec.ts` (draft concurrency, expiry, ownership, tamper, kill-switch, consent) + `test/integration/agent/nudges.spec.ts` — **12/12 tests on the disposable Aurora fixture** (`AWS_P13_INTEGRATION=yes`, IAM auth). The earlier Organizations `rds-db:connect` deny no longer applies.
- Server: eslint clean, boundary check (567 files), manifest validation, full unit suite 385 green, typecheck clean.
- OpenAPI regenerated: `server/openapi/customer.json` now exports the 11 `customerAgent*` operations (gitignored artifact); `milk_customer` client types regenerated and committed.
- App: `pnpm test` 97/97 green, `tsc --noEmit` clean.


## Phases 2–4 done this session (committed)
- Phase 2 (`feat(agent): complete shopping and support tools`): order-history summary, live tracking (`CUSTOMER_TRACKING`), serviceability by address, typed-address parsing (structure only — coordinates always come from the device via the app screen, per ADR 0003), configured policy text, `clear_cart`, `select_address_for_order`, `escalate_to_human`, `request_refund` (support ticket after approval, `refund_confirm` card), safe-error codes extended. 11 unit tests.
- Phase 3 (`feat(agent): bounded history, usage accounting, reorder nudges`): `trimMessages` window via `wrapModelCall` middleware (`agent_history_max_tokens`), system notes moved into the system-message suffix so trimming cannot drop them; `agent_runs` records real model/tokens/tool-calls (migration 050 + `thinking_tokens`); expired pending drafts no longer block chat (ADR 0004); ADRs 0002 (single agent, no routing) and 0003.
- Phase 4: reorder-nudges worker (opt-in `set_reorder_nudges` tool, median-interval sweep, 7-day dedupe, ISO-week cap, PROMOTIONAL outbox plan with en/hi/te templates in migration 051), wired into the worker role. Unit tests + typecheck + lint + boundary/manifest checks all green (385 unit tests).
- Live adapter smoke (factory → real endpoints, thinking on): NVIDIA tool call correct with reasoning tokens separate; Google tool call correct; Gemma thinking arrives as `thought: true` parts and is filtered by `messageDeltaText`.


## Historical status (from the implementing handoff, 17 November 2026)

The assistant was **partially implemented, disabled, and not ready for customer use**. Both the server environment switch (`AGENT_ENABLED`) and the remote `agent_enabled` feature flag default off. The scripted fake model is a test double and is not a general conversational model.

**Working arrangement:** the owner intends another agent to implement the remaining work. This handoff is for that implementer. The present assistant is to review progress and correct mistakes when the owner asks; do not assume it is continuously monitoring the other agent. Preserve existing, unrelated work and report facts and remaining gaps accurately.

The last completed discovery commit was `f090c54` (`docs(agent): map customer assistant integration`). The existing working tree also contains user-owned changes, including deleted `audit.md` and `plan.md`; do not restore, delete, or commit unrelated work without checking first.

## Implemented in the working tree

- **Customer app:** feature-gated Home entry; text chat with streaming and JSON fallback; English, Hindi and Telugu assistant strings; product, order and confirmation cards; retry and stop controls; earlier-message loading; feedback; consent screen; and profile controls to withdraw consent or delete assistant conversations. Entry points include `milk_customer/app/agent.tsx`, `milk_customer/components/connected/AssistantCard.tsx`, and `milk_customer/src/agent/`.
- **Assistant backend:** customer-authenticated endpoints in `server/src/surfaces/customer/agent/customer.controller.ts`; feature/consent checks; owner-scoped threads, messages and drafts; per-user budgets; a Redis run lease; a LangChain/LangGraph runtime and Postgres checkpointer; model factory; and a scripted fake model.
- **Tools and approvals:** wrappers for customer addresses, catalog search, cart reading/quantity changes, recent order details, wallet balances and support tickets; confirmation-gated cancellation and checkout code that uses existing backend operations; idempotency and expiry safeguards. The database-backed behavior has **not** yet passed integration tests.
- **Privacy and schema foundations:** AI consent/revocation and customer conversation deletion; retention/account-erasure hooks; additive migration `server/db/migrations/050_customer_agent.sql`; operator-run `pnpm agent:checkpoints` setup and updated runtime grants. These have **not** been applied to the application database.
- **Provider plumbing:** exact LangChain dependencies are pinned; the factory supports a fake model and configurations for several providers including OpenAI-compatible endpoints. Google and NVIDIA credentials were subsequently supplied and direct provider smoke tests passed; the application's model adapters have **not** been verified with these endpoints. OpenRouter has **not** been configured or verified against a live model.

Detailed discovery, decisions, and status remain in `server/docs/agent/DISCOVERY.md`, `server/docs/agent/DECISIONS/`, `server/docs/agent/PROGRESS.md`, and `server/docs/agent/HANDOFF.md`.

## What still needs implementation or verification

- Complete typed-address parsing/confirmation and automatic continuation of the original request, using trusted device coordinates and existing serviceability rules.
- Complete robust interrupted-run and checkout recovery, skill routing, token-bounded history, provider error handling, and prompt-injection/cost safeguards.
- Implement and evaluate refund-request confirmation, reorder/usual order, recipes, substitutions, eligible coupons, configured FAQ/policy answers, and opt-in reorder nudges. Subscription tools must respect the existing feature flag; do not enable subscriptions merely to test them.
- Generate the finalized customer OpenAPI contract and client types; complete multilingual, accessibility and realistic scenario evaluations, including Telugu and mixed-language prompts.
- Run database/cache integration, privacy/erasure, concurrency, replay, expiry and order/cancellation tests against **isolated AWS test data**. Then test in Expo Go on the owner's phone.
- Keep the assistant disabled until implementation and all required checks are complete. No native or EAS build may be started before Expo Go testing and the owner's explicit approval.

## Verification already performed

- AWS Lambda: server TypeScript, 17 focused assistant unit tests, server lint, module-boundary check and manifest validation passed. The model-request tests use a mocked provider and verify that the requested OpenRouter thinking setting is sent; they do not call a live model.
- AWS Lambda: customer-app TypeScript, assistant stream-parser tests and lint on the changed app files passed. Full customer-app lint still reports pre-existing errors in other test and script files.
- AWS Lambda, 17 November 2026: direct Google AI Studio and NVIDIA API credentials passed **synthetic-only** smoke requests. With thinking requested, each returned the correct fictional basket total and selected a `lookup_catalog` function with the requested SKU. Both also described the public sample traffic sign as a red STOP sign; Google returned one temporary HTTP 503 before a single successful retry. NVIDIA's text test used streaming and received separate reasoning; Google's test returned thinking-token usage. This does **not** verify the server's LangChain adapters, an actual DairyDirect workflow, or safety and quality in production.
- The attempted isolated Aurora integration stopped at IAM authentication; no test database was created. AWS Organizations explicitly denied `rds-db:connect` and `elasticache:Connect` for the development test role. The organization administrator must permit the appropriate scoped access before those tests can run.
- No production migration, deployment, native/EAS build, local database, Docker, or local test runner was used for this assistant work. Aurora/cache availability and account policies may have changed since the last check; recheck before testing.

## Model research, 17 November 2026

The owner selected Nemotron 3.5 Super VL with thinking enabled for initial development and has now supplied a **direct NVIDIA** key. The direct model ID that passed the smoke test is `nvidia/nemotron-3.5-super-vl-120b-a12b`. OpenRouter also lists `nvidia/nemotron-3.5-super-vl:free`, but that is a different endpoint and credential; the server's `OPENROUTER_REASONING=on` setting applies only to OpenRouter. For a longer-term AWS-hosting path, NVIDIA publishes the model weights. Its trial endpoint must receive only synthetic data, and the 120B-total-parameter model needs substantial hardware. Particle-1 is an alternative post-trained from DeepSeek V4.1 Flash, but a public release of the exact Particle-1 fine-tuned weights has not been verified. The selected model has not been evaluated inside this application yet. Test Telugu, Hindi, mixed-language and order-tool scenarios. See [NVIDIA's model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4), [OpenRouter's model page](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free), and [Particle's announcement](https://particle.ai/blog/introducing-particle-1).

`google/gemma-4-26b-a4b-it:free` remains a smaller, cheaper-to-explore AWS-hosting candidate. It supports tool calls, has a 262,144-token context, and has open weights suited to later self-hosting. Its free endpoint supports JSON mode but does **not** enforce a JSON schema; the backend must validate every tool argument and response. Compare its results with `google/gemma-4-31b-it:free` before selecting a production model. Neither candidate has been evaluated on this application's own scenarios yet.

OpenRouter's documented `:free` allowance at research time was 20 requests/minute and 50 requests/UTC day, rising to 1,000/day once sufficient credits have been purchased. The quota is shared across free-model use, and provider-side capacity limits can be lower. Agent turns can make several model calls, so requests are not equivalent to customer messages. Verify live limits and provider policies before relying on them.

NVIDIA's free Nemotron 3.5 Lightning and Super VL endpoints explicitly warn against sending personal or confidential data. Use synthetic data there, and independently review any provider's data handling before using real customer information. See [Gemma 26B on OpenRouter](https://openrouter.ai/google/gemma-4-26b-a4b-it:free), [free-model limits](https://openrouter.ai/collections/free-models/), [NVIDIA Lightning's free endpoint](https://openrouter.ai/nvidia/nemotron-3.5-lightning:free), and [Google's Gemma documentation](https://ai.google.dev/gemma/docs/core).

Possible **future test configuration only**, once the feature and access are ready:

```dotenv
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=nvidia/nemotron-3.5-super-vl:free
OPENROUTER_REASONING=on
# Supply the OpenRouter key securely as OPENAI_API_KEY on the server.
```

The OpenAI-compatible path and this particular model/provider combination still require a live, synthetic-data integration test. The current adapter may drop OpenRouter's `reasoning_details`; confirm that reasoning metadata survives tool calls, and fix the adapter if needed, before enabling the assistant. The existing 1,024-token output limit includes reasoning and may truncate answers; adjust it only after measurement. Do not put keys in the mobile app, repository, screenshots, or chat. Do not enable the assistant simply by adding these settings.

### Nemotron 3.5 Super VL versus Gemma 4 26B-A4B

- The owner selected Nemotron with thinking for initial development; keep that selection until application-specific tests justify a change. The owner also supplied a Google key for the comparison. Neither model has yet been evaluated on DairyDirect conversations.
- [NVIDIA's direct comparison](https://arxiv.org/html/2610.33039) reports higher scores for Nemotron on most included agent, reasoning and visual browsing benchmarks, while Gemma leads on IFBench instruction following. The comparison uses the Nemotron BF16 checkpoint; the exact OpenRouter free-endpoint quantization is unspecified.
- On Tau2 retail, [Google reports 85.5 for Gemma](https://arxiv.org/html/2607.02770) and [NVIDIA reports 69.24 for Nemotron](https://arxiv.org/html/2610.38095). These are separate evaluations with potentially different settings; they are useful signals, not a controlled head-to-head comparison.
- NVIDIA reports Telugu and romanized Telugu among the priority languages used to create its Indic corpus, with a selected subset used for continued pretraining. Its model card does not list Telugu among the post-training focus languages. An [independent agriculture research report](https://thealliance.ai/hubfs/Sov_India_Stack_Blog/svaiam-sovereign-ai-stack-india.pdf) reports a good Telugu-domain result for Gemma, without directly comparing Nemotron. Test both on Telugu and Telugu-English ordering scenarios.
- [Google estimates](https://ai.google.dev/gemma/docs/core.md) about 14.4 GB for Gemma's 4-bit model weights, before runtime and context needs. NVIDIA's published full-context examples use 1 H200 or 2 H100 GPUs. Compare quality, latency, concurrency and regional AWS costs before selecting infrastructure; avoid treating those example configurations as absolute minimums.
- The [OpenRouter Gemma](https://openrouter.ai/api/v1/models/google/gemma-4-26b-a4b-it:free/endpoints) and [Nemotron](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-super-vl:free/endpoints) endpoint metadata reported no current 30-minute latency or throughput measurement when checked. The free quota is shared and the NVIDIA free endpoint prohibits personal or confidential data. Use fabricated data and verify each provider's policies.

## Credentials, direct provider smoke test, and quota handling

The owner's direct-provider credentials are stored in this workspace as environment entries `GOOGLE_API_KEY` and `NVIDIA_API_KEY` in the Git-ignored `server/.env` with mode `0600`. Never print, copy, commit, include in a test fixture, place in a mobile bundle, or add the values to a ticket or report. They were supplied in chat, so replace them with freshly rotated credentials before production or broader use. Use the deployment platform's secret management for deployed environments; do not infer that a local `.env` is an AWS deployment secret.

| Direct provider | Endpoint and requested model | Smoke result | Important remaining work |
| --- | --- | --- | --- |
| Google AI Studio / Gemini API | `generativelanguage.googleapis.com`, `gemma-4-26b-a4b-it`; `thinkingConfig.thinkingLevel=high` | Fictional total correct; synthetic lookup function called with correct SKU. The sample image request first returned HTTP 503/high demand and succeeded on one retry. | Test the **actual server adapter**, streaming, thinking/signature preservation across a tool result, failures, and multilingual scenarios. |
| NVIDIA API catalog | `https://integrate.api.nvidia.com/v1`, `nvidia/nemotron-3.5-super-vl-120b-a12b`; `chat_template_kwargs.enable_thinking=true` | Fictional total correct with streamed reasoning separate from final text; synthetic lookup function called with correct SKU; sample image request succeeded. | Implement/test direct NVIDIA key and thinking wiring in the existing factory; verify streaming and multi-step tool continuations through the server. |

The NVIDIA text smoke request completed in about 2.1 seconds and the Google text request in about 5.1 seconds, but the former streamed and the latter did not; each is one observation, **not a speed comparison**. Both providers described the same publicly hosted NVIDIA sample image as a red STOP sign; this was not independently image-verified. All text and tool prompts contained fabricated data. No actual catalog, customer, order, or database was used, and no provider rate-limit response headers were returned. In total there were four Google calls (including one temporary 503 and its single retry) and three NVIDIA calls. Temporary AWS Lambda functions, log groups, and the temporary credential payload were deleted after testing.

**Direct NVIDIA is not yet wired up.** `server/src/config/env.schema.ts` currently has no `NVIDIA_API_KEY` field, `infrastructure/config.ts` and `llm.factory.ts` look for `OPENAI_API_KEY` for `openai_compatible`, and the explicit reasoning option currently targets OpenRouter. Simply saving `NVIDIA_API_KEY` does not activate or configure the assistant. Add typed, provider-appropriate configuration and pass the NVIDIA-specific thinking option only for the correct endpoint; never leak the NVIDIA key into unrelated providers. Preserve existing provider behavior. For Google, verify that the LangChain adapter really requests Gemma's `high` thinking setting; a raw REST success does not prove that it does. Both providers may require their reasoning/thought metadata to be retained across tool calls; verify multi-turn behavior and ensure reasoning is never sent as customer-visible text.

**Direct Google limits:** [Google's rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) says limits vary by model, project and account tier, apply per project rather than per API key, and daily limits reset at midnight Pacific time. The owner's exact quota was not returned by these tests; check [AI Studio rate limits](https://aistudio.google.com/rate-limit) rather than guessing. Count requests, input tokens, output and thinking tokens; rotating keys does not create a separate project quota.

**Direct NVIDIA limits:** its API catalog is a trial service; limits and credits vary with the account, model and load. The smoke response did not expose an exact quota. Do not assume OpenRouter's free limits apply to direct NVIDIA. Stop or back off on HTTP 429, honor `Retry-After` when supplied, surface 402/credit exhaustion, cap retries, concurrency and total evaluation spend, and avoid retry storms. NVIDIA's [API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf) restrict trial use to evaluation and require an appropriate subscription for production use. Review the actual provider, retention and data-processing terms before enabling any real customer traffic. Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) notes that free-tier content can be used to improve products.

**OpenRouter is separate:** its documented `:free` quota of 20 requests/minute and 50/day, or 1,000/day after the qualifying credit purchase, applies to OpenRouter free-model traffic. It is not the direct Google or NVIDIA quota and no OpenRouter key has been provided.

## Detailed implementation handoff

The prompt file remains the full specification, subject to the owner's later product decisions: **COD and existing wallet balances only; online payments and maps remain marked as under development; no wallet top-up; subscriptions remain disabled unless explicitly enabled later.** Do not implement a top-up link or activate subscriptions merely because the older prompt mentions them. The customer assistant is text-only, must work in Expo Go, and must not expose any model credential in the app.

### 1. Foundation and provider adapters

- [ ] Keep `AGENT_ENABLED` and the remote `agent_enabled` flag off by default; boot with all model configuration unset and hide/deny the assistant cleanly when unconfigured.
- [ ] Complete typed configuration for direct NVIDIA, Google, local fake and the existing providers. Validate selected URLs and keys, choose a model explicitly, and keep secrets server-side. Support the user's NVIDIA thinking option and Google's documented Gemma thinking mode without conflating them with OpenRouter.
- [ ] Verify `initChatModel`, provider tool support, provider-specific request options, responses and retry behavior against the exact pinned package versions. Preserve necessary reasoning or thought signatures through tool calls while filtering them from UI events, stored messages and logs.
- [ ] Test fail-closed startup, missing/bad key, unavailable model, model without tool support, timeout, 429, expired credits and provider errors. Use bounded exponential backoff with jitter and a circuit breaker; do not retry unsafe actions without idempotency.
- [ ] Implement/test actual provider fallback and skill routing, or document and test a deliberate simpler configuration. Current `runtime.ts` builds one agent with all currently available tools; the requested router/skills and token-bounded `trimMessages` history are not complete.
- [ ] Move the current inline system prompt into versioned files; add dynamic IST date/locale and minimal customer context, record prompt/model versions, and evaluate changes before release. Never log prompts or reasoning.

### 2. Tool framework, safety, drafts and actions

- [ ] Complete the shared typed tool wrapper with authenticated context injected from the server, per-tool timeouts and safe error envelopes. No tool schema may accept a customer ID; domain services enforce ownership and business rules.
- [ ] Complete and test the reusable T2 confirmation contract: server-created draft and preview, immutable stored payload/hash, user/thread ownership, expiry, fresh server-side quote/eligibility and idempotent execute after approval. Reject, stale, expired and forged requests must never mutate data.
- [ ] Resolve the current pending-draft behavior: `runs.ts` rejects new messages with `DRAFT_PENDING`, while the prompt asks for safe supersession and continuation. Design and test the LangGraph interrupt/checkpoint transition; never discard or execute a draft silently.
- [ ] Expand deterministic card actions beyond the current `add_to_cart` only where the matching capability exists. Validate card ownership, type, action, allowed IDs and quantities server-side; make repeated actions safe and update conversation state.
- [ ] Sanitize and bound all untrusted catalog, address, support and coupon data; enforce max tool calls, duplicate-call loop protection, steps, run time, message length, quantity, order value and per-user budgets. Test prompt injection and secret/PII leaks.

### 3. Shopping, addresses and checkout

- [ ] Complete the quick-order journey: identify the owned/default address, search store-scoped products, ask about ambiguity, preserve unrelated cart items, use existing cart/quote/checkout rules, show authoritative totals and place exactly one order after approval.
- [ ] Finish address parsing, missing-field prompts, candidate storage, serviceability and confirmed save using trusted device-provided coordinates. Never invent coordinates or claim map search is available. Restore the original pending order after saving; handle duplicate, unsupported, unserviceable or abandoned addresses.
- [ ] Wire reorder/history summaries, recipe ingredient matching, in-stock substitutes, eligible coupons and refreshed cards to existing domain-owned services. Add missing customer-safe contracts in their owning domains rather than duplicating business rules inside the agent.
- [ ] Handle inventory/price/zone changes, coupon expiry, cart conflicts, closed store, COD eligibility, insufficient wallet balance and changed quotes between preview and confirmation; never execute a stale draft. Preserve unavailable online-payment behavior.
- [ ] Test interrupted placement, replay, double confirmation, concurrent taps, retries after unknown network outcomes, expired intents and recovery. Verify the final database state and the existing checkout/idempotency owner, not just chat text.

### 4. Order support, subscriptions and notifications

- [ ] Complete owned order status/tracking, cancellation under existing policy, issue reporting and human escalation. Confirm refund requests before creating the appropriate existing support request; never promise or execute a refund outside the authorized domain flow.
- [ ] Implement subscription wrappers only behind the existing subscription feature flag and existing backend rules. While disabled, neither tools nor UI should offer subscription changes. If enabled in the future, test explicit IST dates, cutoff rules and approved drafts.
- [ ] Add opt-in reorder nudges through the existing notification service with deduplication, frequency caps, quiet hours and preference checks. Never auto-send a chat message, and keep the global nudge flag off until tested.

### 5. Customer Expo UI and API contracts

- [ ] Complete the plain text-only chat, disclosure/consent, cached feature gate, language strings, streaming/JSON fallback, history, stop, retry, offline and empty/error states. Handle keyboard, screen readers, reduced motion, dynamic text and usable touch targets.
- [ ] Finish server-authoritative product, order, status, address and confirmation cards; disable expired/used cards, make double taps safe, show actionable error states and restore pending state after a restart or dropped connection.
- [ ] Complete client resynchronization after stream loss, app backgrounding, reconnect and interrupted drafts without duplicate sends. Ensure no model reasoning, hidden tool arguments or internal error details appear in chat.
- [ ] Finalize server-owned card/event types, regenerate `server/openapi/customer.json` and the generated customer client types, and validate auth, ownership, SSE ordering and JSON fallback. Read `milk_customer/AGENTS.md` and the matching Expo documentation before touching Expo APIs.

### 6. Data, privacy, observability and reliability

- [ ] Review migration `server/db/migrations/050_customer_agent.sql`, checkpoint setup `pnpm agent:checkpoints`, runtime grants and rollback/recovery with an isolated AWS database before applying anything to production. Check Aurora/Valkey availability and current IAM policies rather than relying on old status.
- [ ] Verify consent is checked before every model call and mutation; test withdrawal, thread deletion, retention and account erasure including LangGraph checkpoints, feedback, drafts, run logs and associated state.
- [ ] Record privacy-safe run metrics: model/provider, prompt version, tool outcome codes, input/output/thinking tokens, time to first visible output and completion, retries, approximate cost and outcome. No raw customer messages, addresses, phone numbers, credentials, tool data or reasoning in logs/traces.
- [ ] Complete stale-draft expiry, stuck-run recovery, run-lease renewal, abort on disconnect, global kill switch, provider outage handling, budget enforcement and documented operator runbooks.

### 7. Verification, comparison and release gates

- [ ] Implement the prompt's deterministic fake-model unit, graph, API and contract suites without requiring real keys. Build at least 60 named scenario cases with isolated fixtures and assertions on tool calls **and resulting database state**.
- [ ] Cover cross-user access, forged cards/drafts/IDs, prompt injection, repeated confirmations, concurrent runs, stale/expired/superseded drafts, refunds, address changes, cart preservation, tool loops, provider failures, deletion and retention. Track every Section 20 edge case in `server/docs/agent/EDGE_CASES.md`.
- [ ] Run database/cache integration, migration, privacy and concurrency checks only on isolated AWS fixtures, using pnpm and modest resources. The last attempt was blocked by AWS Organizations explicit deny for `rds-db:connect` and `elasticache:Connect`; an organization administrator must permit the scoped test role before those IAM tests can succeed. Do not use production customer data.
- [ ] Build a rate-limited **opt-in live evaluation** for both direct models using only fabricated data. Start with small batches, one request at a time per provider and configurable conservative pacing; stop on 429/credit errors. Compare identical English/Hindi/Telugu/mixed prompts, tool selection and argument correctness, completed tool-result continuation, authorization and confirmation behavior, answer quality, token usage, and p50/p95 first-visible and completed-response latency. One smoke test is not a benchmark.
- [ ] Run server/customer typecheck, appropriate tests, lint, boundary and manifest checks on AWS. Document any pre-existing full-app lint failures distinctly; don't declare the feature green while required checks are failing.
- [ ] Test the full customer flow in Expo Go on the owner's phone. **No native or EAS build before that test and the owner's explicit approval.** Do not apply production migrations, deploy, or enable the assistant while unfinished.
- [ ] Finish `server/docs/agent/ARCHITECTURE.md`, `TOOLS.md`, `PROMPTS.md`, `EVALS.md`, `RUNBOOK.md`, `EDGE_CASES.md`, ADRs and `HANDOFF.md`; update `server/docs/agent/PROGRESS.md` and this file as each phase actually passes. Distinguish implemented code, tested behavior, blocked work and owner actions.

## Product and workflow constraints

- Use pnpm. Do not use a local database, local test runner, or Docker for testing; use AWS services with isolated test fixtures and keep usage modest.
- Do not change the delivery-partner, store-manager, or admin apps as part of this customer-assistant task.
- Cash on delivery and existing wallet balances follow the current backend rules. Online payments and maps remain marked as unavailable; do not add wallet top-up or enable subscriptions.
- Real prices, stock, serviceability, order status and money movement must come from existing backend services. A model may propose an action; server validation and explicit customer confirmation determine whether it happens.
- Do not assume access policies are fixed or that Aurora's reported cluster status proves a successful database connection. Recheck safely without modifying customer data.
