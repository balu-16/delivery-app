# DairyDirect customer assistant — progress and handoff

Last reviewed: **18 November 2026**. This document describes the customer assistant, not the whole DairyDirect application. The implementation review used the working tree and saved reports; the later model comparison and AWS resource checks are recorded separately below.

## Current status

The assistant has substantial implementation, but it is **not ready for customer release**. The latest model comparison could not complete Gemma's scenarios, the customer journey has not been tested in Expo Go, and the gaps below need review. The server and remote assistant switches default off; the live feature flags were not checked. Aurora and Valkey reported available during the later AWS resource check; application connectivity was not verified by that check.

The owner chose Nemotron 3.5 Super VL with thinking enabled as the initial development candidate. A final choice between Nemotron and Gemma must wait for comparable application-specific evaluations; the saved results do not establish a winner.

### Approved product scope

- Include customer shopping, saved addresses, cart, checkout, order tracking, cancellations, order support and **opt-in reorder nudges**.
- Allow eligible cash on delivery and existing wallet balances. **Do not add wallet top-ups.**
- **Do not implement subscriptions or recipe suggestions for now.** Keep normal order and delivery notifications.
- Maps and online payments remain marked as under development. Never invent delivery coordinates or make unavailable features appear ready.
- The existing `customer-app-agent-prompt.md` still requests subscriptions, recipes and a wallet top-up link. Those instructions are outdated; the owner's decisions above take precedence. That file was not changed in this review.
- Coupons and substitutes were deferred by the implementing agent in ADR 0003. The owner did not clearly exclude them alongside subscriptions and recipes; treat them as outstanding against the original prompt rather than silently declaring them out of scope.

### Repository state

The implementing agent committed the foundation, shopping/support tools, history and nudge work, generated customer client types, and the live-evaluation harness. The latest agent documentation commit is `c19ea41`; earlier implementation commits include `4a1a62b`, `e3305cb`, `770bc40` and `d1b3d45`.

Two files contain **uncommitted work from the implementing session**:

- `server/src/modules/agent/infrastructure/runtime.ts`: prompt changes and provider-error logging.
- `server/scripts/agent-live-evals.ts`: fixture, scenario, retry and refund-query changes.

Review and preserve these changes; do not assume they passed the previously reported checks. The existing deletions of `audit.md` and `plan.md` and the untracked `customer-app-agent-prompt.md` are separate working-tree state and must not be restored, removed or committed without context.

## Implemented in the working tree

- **Customer app:** feature-gated assistant entry, text chat, streaming/JSON client, English/Hindi/Telugu strings, suggested prompts, server-owned cards, consent and privacy controls, history, retry/stop controls and an address-panel handoff. The complete experience still needs a phone walkthrough.
- **Assistant backend:** authenticated customer endpoints, consent and feature checks, owner-scoped threads/messages/drafts, Redis run lease, usage limits, LangGraph checkpointing, confirmation interrupts, and privacy/retention hooks.
- **Provider configuration:** the model factory supports direct NVIDIA and Google credentials, `LLM_THINKING` for those providers, and the existing fake/other provider paths. The code filters known thinking blocks from visible assistant messages. End-to-end tool continuation and all provider-failure cases still require verification.
- **Shopping and support:** the code has product, cart, address, history, order, tracking, serviceability, policy and wallet reads; cart/support writes; and confirmation-based order, cancellation and refund-request flows. Refund requests create support tickets; they do not promise a refund. The current source contains 20 tool definitions; older agent documentation says 16 and needs reconciliation.
- **Reorder nudges:** an opt-in preference tool, scheduled worker, candidate selection, global flag, notification event and English/Hindi/Telugu templates exist. The implementation still needs the reliability checks listed below.
- **Schema and contract:** migrations `050_customer_agent.sql` and `051_agent_nudge_templates.sql`, a checkpoint-setup command and runtime-grant changes exist. Customer client types were regenerated and committed. The other agent reported that the migrations were not applied to the application database; this review did not independently check the live database. Generated OpenAPI and evaluation artifacts are Git-ignored.

Supporting material is in `server/docs/agent/`, including `TOOLS.md`, `EVALS.md`, `EDGE_CASES.md` and ADRs 0001–0004. These documents contain useful context, but some completion claims and the tool count are stale.

## Model comparison — 18 November 2026

Ran the direct NVIDIA and Google provider APIs from a temporary AWS Lambda, with thinking enabled for both. The test used the **10 development products and prices in `server/scripts/seed-test-dairy-data.ts`**, with fabricated customer, address, order and wallet details and in-memory, application-inspired tool responses. The catalog was not freshly read from Aurora; this is not a test of the actual app, provider adapter, production tool definitions or database. No real customer records were sent to either provider. The tool mock does not establish whether an action would be valid under the real business rules.

The same 11 scenarios were planned for each provider: English, Telugu and mixed-language ordering; choosing an ambiguous milk; tracking; cancellation and refund requests; wallet balance; unavailable wallet top-up; missing address; and opt-in nudges. A stop rule ended a provider's run after repeated errors. The retry was a separate run, not part of the initial score.

| Run | Result | Interpretation |
| --- | --- | --- |
| Nemotron 3.5 Super VL, initial run | **9/11 after manual correction**, 31 provider requests | The product/quantity and confirmation checks passed for the three ordering prompts. Ambiguous selection, tracking, refund-request draft, wallet balance, missing address and nudge opt-in met the limited checks. The cancellation draft was not created. For wallet top-up, the model incorrectly suggested that funds could be added through the app or website. |
| Gemma 4 26B A4B, initial run | **0/2 completed**, 3 provider requests | Both attempted scenarios encountered HTTP 503 `UNAVAILABLE` with a high-demand message; one reached a tool call before the error. The remaining scenarios were stopped. These are availability failures, not evidence that the model cannot solve the tasks. |
| Gemma, separate retry | **0/1 completed**, 2 provider requests | After a cooldown, the English order reached a search tool call and then returned another high-demand HTTP 503. The retry stopped on that error. |

The automated scorer originally marked the NVIDIA wallet-top-up answer as a pass because it noticed the words saying the feature was unavailable; manual review caught its contradictory recommendation. The **9/11** figure corrects that false pass. The first run retained only the first 200 characters of each answer, so full-response quality and Telugu fluency were not comprehensively checked. Treat the passes as limited scripted checks, not a safety certification. Cancellation needs an actual confirmation card rather than only a conversational request for confirmation.

Nemotron's scenario times ranged from **0.7 to 12.1 seconds**, with a **5.4-second median**. These include tool turns, network calls and deliberate 1.8-second waits between requests; they are not first-token latency or model-only speed measurements. Gemma did not complete a comparable scenario, so its speed and overall quality cannot be fairly ranked against Nemotron from this run. Nemotron is the more usable candidate in this limited test, but its wallet answer must be corrected and both providers need the same complete app-integrated evaluation before a final decision.

The sanitized raw results and manual correction are saved at `server/artifacts/agent-evals/model-comparison-2026-11-18.json` (Git-ignored). The temporary test functions were deleted. The initial provider runs stopped after consecutive errors; the separate Google retry stopped at the first provider error. No model-provider retries should continue automatically after a rate limit or repeated service failure.

**AWS check at test time:** Aurora cluster `database-1` and its instance, and Valkey `delivery-app`, reported `available`. Cognito pools, S3 buckets and SQS queues could be listed; listing confirms that resources exist, not that sign-in or application operations work. SES sending was enabled but the account was in sandbox mode. Lambda successfully ran the model tests. These checks do not prove backend connectivity or cover every AWS service in the account.

## Saved model evaluation results

The reports below are earlier files under the Git-ignored `server/artifacts/agent-evals/` directory. They may be lost if artifacts are cleaned. The scenarios use fabricated data; the results are not proof of production readiness. These earlier app-integrated evaluations were not rerun in the later direct-provider comparison above.

| Provider and saved report | Result | What it establishes |
| --- | --- | --- |
| NVIDIA `nvidia-1794942492244.json` | **13/14 passed** | Latest saved full 14-scenario run. `refund-request` failed with a test-harness database-column error. |
| NVIDIA `nvidia-1794942879422.json` | **1/1 passed** | A separate targeted `refund-request` rerun passed. It is not the same run as the 13/14 result. |
| Google `google-1794943241717.json` | **0/3 passed** | English, Telugu and mixed-language quick-order scenarios failed; each recorded `AGENT_UNAVAILABLE`. |
| Google `google-1794943846812.json` | **0/1 passed** | A later targeted English quick-order run failed and recorded `AGENT_UNAVAILABLE`. |

The earlier direct-provider smoke checks and the implementing agent's factory smoke were reported successful for both providers with synthetic prompts. They establish basic endpoint/tool-call access at that time, not a successful DairyDirect ordering journey. Google also returned a temporary 503 in an earlier image smoke test before one retry succeeded.

The current uncommitted evaluation changes include a fix changing the refund query to `support_tickets.owner_id`, which matches the support schema, plus COD fixture and scenario changes. The full suite has not been rerun on the exact current working tree. Do not combine a full run, a targeted rerun and changed scenarios into a claimed 14/14 result.

**Evaluation harness review:** streamed `run.error` events are collected inside scenario turns, while the retry branch checks the scenario's thrown `error` field. Therefore an `AGENT_UNAVAILABLE` event can become an assertion failure without taking that retry branch. The retry branch also prints the original result rather than necessarily the final retried result. Review these behaviors and the uncommitted retry limits before another live run; diagnose Gemma's actual error without logging customer content or credentials.

## Previously reported checks

The implementing agent reported the following on 17 November 2026. These are historical reports, not checks independently repeated for the current working tree:

- **AWS Aurora integration:** 12/12 tests across `confirmation.spec.ts` and `nudges.spec.ts`, using a disposable database and synthetic fixtures. The three confirmation tests exercise draft concurrency, expiry, ownership, tampering, consent and the kill switch; they should not be described as a comprehensive checkout integration suite.
- **Server:** typecheck, lint, module boundaries and manifest validation passed; the agent documents report 385 tests in one place and 388+ in another, so the exact latest count is not reconciled here.
- **Customer app:** 97/97 tests and TypeScript were reported passing; generated customer client types were committed.
- The implementing session reported successful AWS database/cache connectivity after earlier IAM restrictions. This review did not verify whether the same access or resource state remains available.

## Remaining work and review priorities

### 1. Make ordering and provider comparison reliable

- [ ] Review the uncommitted runtime and evaluation changes. Remove or sanitize raw provider exception messages before relying on the new logging: an error message may include request or customer information.
- [ ] Diagnose the Gemma `AGENT_UNAVAILABLE` failures and fix the confirmed harness issues. Preserve provider rate limits, honor 429/503 and `Retry-After` where available, cap retries/concurrency and avoid repeated expensive runs.
- [ ] After fixes, run the **same version of the same scenarios** for both direct models, with thinking enabled, against isolated AWS fixtures and synthetic customer/order data. Compare task completion, correct tool calls and arguments, confirmations and resulting database state, English/Telugu/mixed-language behavior, first-visible and total latency, errors and token usage.
- [ ] Record full-run and targeted-rerun results separately, including scenario versions and failures. Do not select a final model on the current partial reports or single-request timings.
- [ ] Verify real provider tool-result continuation, thinking metadata handling, streaming, cancellation, timeouts, error recovery, and that internal reasoning never appears in customer-visible output or logs.

### 2. Finish the customer journey

- [ ] Test shopping, reorder, serviceability, cart changes, COD/existing wallet checkout, order status, cancellation, support escalation and confirmed refund requests end to end. Verify authoritative totals and that money-changing actions happen only after confirmation.
- [ ] Complete or explicitly resolve the **address continuation gap**. The parser can structure typed text and show an address action, but the app currently opens `AddressPanel` with an `onClose` callback; no explicit pending-intent/resume path was found. Test returning from a saved address and continuing the original order without inventing coordinates.
- [ ] Review pending confirmations: ADR 0004 intentionally blocks new messages with `DRAFT_PENDING` until a decision or expiry, rather than the original prompt's supersession behavior. Verify the customer can recover safely from expiry, app restart, interruption and an approved-but-unexecuted draft.
- [ ] Check missing or stale confirmations, price/stock/address changes, duplicate sends and approvals, cross-user access, online-payment-unavailable behavior, accessibility, keyboard handling, offline/reconnect and retention/erasure.
- [ ] Implement or explicitly resolve the deferred customer-safe coupon and substitute behavior from the original prompt. Do not add subscriptions, recipes or wallet top-ups while resolving it.

### 3. Finish reorder nudges

- [ ] Fix or otherwise resolve sweep fairness: `runSweep` selects at most 50 opted-in users ordered by preference `updated_at`, but the sweep does not advance that ordering. With more than 50 unchanged preferences, later users may never be processed.
- [ ] Review deduplication and weekly caps with overlapping workers and delayed notification processing; the worker checks existing notifications before appending a new outbox event. Verify the behavior under concurrency rather than assuming one event per user.
- [ ] Implement and test the requested stop-after-ignored behavior; `ignored_count` is currently reserved but no feedback loop uses it.
- [ ] Verify opt-in, opt-out, notification preferences, IST quiet hours, stock/cart/active-order suppression, deduplication, limits and the notification-to-assistant journey end to end. Confirm the intended prefilled suggestion behavior; the current notification plan links to `/agent`.

### 4. Verification, documentation and release

- [ ] Expand deterministic fake-model, API, graph, integration and adversarial coverage against the approved scope. The original prompt calls for at least 60 named scenarios; completion of that suite is not evidenced by the saved 14-scenario live harness.
- [ ] Run required checks with pnpm on AWS and isolated test data, with modest usage. Do not use Docker, a local database or local test runners. Current AWS permissions and Aurora/Valkey availability must be checked at the time of testing, not inferred from old reports.
- [ ] Test the complete experience in **Expo Go on the owner's phone**. No native or EAS build may start before that test and the owner's explicit approval.
- [ ] Add or reconcile the missing `server/docs/agent/ARCHITECTURE.md`, `PROMPTS.md` and `RUNBOOK.md`; update the existing progress, handoff, evaluation, tool and edge-case documents to reflect verified behavior and the owner's scope. The older main prompt also needs a separate scope correction.
- [ ] Review migrations `050` and `051`, checkpoint setup, runtime grants, retention, rollback and provider terms before any eventual deployment or enabling of the assistant. Do not infer that a migration has been applied from its presence in Git.

## Credentials and provider limits

The owner supplied `GOOGLE_API_KEY` and `NVIDIA_API_KEY` in the Git-ignored `server/.env`. Never print, commit, copy into a test fixture, place in a mobile bundle or include the values in a report. Because the keys were supplied in chat, rotate them before broader or production use; deployed environments need their own secure secret management.

- **Direct Google AI Studio:** `gemma-4-26b-a4b-it`; the tested thinking setting is `thinkingLevel=high`. Limits depend on model, project and tier; check [Google's rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) and the account's AI Studio dashboard. Free-tier data handling must be reviewed before real customer traffic.
- **Direct NVIDIA API catalog:** `nvidia/nemotron-3.5-super-vl-120b-a12b`; the tested setting is `chat_template_kwargs.enable_thinking=true`. The [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf) restrict trial use and personal/confidential data. Use synthetic data and review production terms before customer traffic.
- **OpenRouter is separate:** its model IDs, API key and free-tier quotas do not describe the direct Google or NVIDIA endpoints. No OpenRouter credential was supplied for this work.

## Working arrangement

The owner may have another agent implement remaining work and will ask for review when wanted. Do not assume continuous monitoring. Preserve unrelated changes, distinguish reported results from verified results, keep the assistant disabled while unfinished, and update this file as work is actually completed.
