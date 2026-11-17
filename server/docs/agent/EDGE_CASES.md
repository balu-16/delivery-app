# Edge-case coverage map

Each item maps to a named test or a documented decision. ✅ tested · 📄 decided (ADR) · ⏳ open.

## Confirmation and money safety
- ✅ No order without an approved draft; reject leaves no side effects — `test/unit/agent/checkout-confirmation.spec.ts` (fake model), `test/integration/agent/confirmation.spec.ts`
- ✅ Four-way concurrent approve → exactly one order effect, replayed result — `test/integration/agent/confirmation.spec.ts`
- ✅ Expired draft rejected and marked; tampered payload hash refused — `test/integration/agent/confirmation.spec.ts`
- ✅ Expired pending drafts stop blocking new messages (marked on next send) — `AgentRuns.begin` SQL + ADR 0004
- ✅ Execution uses the stored draft payload, never model arguments — `confirm-tools.ts` parses `drafts.decide` stored payload; refund re-verifies hash inside the ticket transaction
- ✅ Order-value cap (`agent_max_order_value_paise`), COD eligibility, quote-expiry bounded draft TTL — `place_order` prepare
- ⏳ Payment intent for online payment — out of scope (online payments under development)

## Address flow
- ✅ No saved address → `ADDRESS_REQUIRED` + add-address info card; nothing invented — `search_products`, no-address eval scenario
- ✅ Typed address parsed structurally; missing fields reported; +91 normalisation — `test/unit/agent/tools.spec.ts`
- ✅ Duplicate detection by first street segment + pincode — `test/unit/agent/tools.spec.ts`
- 📄 Coordinates only from the device via the app screen; no server-side geocoding — ADR 0003
- ⏳ Address-limit reached mid-flow (tool exists: `ADDRESS_LIMIT_REACHED` surfaces as safe error; no dedicated scenario yet)

## Products and cart
- ✅ Ambiguous product → must ask, no draft — live-eval `ambiguous-product` scenario + assertion
- ✅ Zero/negative/huge quantities rejected; absolute set semantics — `assertQuantity` unit tests
- ✅ Card `add_to_cart` payload must hash-match a stored card option (forged ids rejected) — `actions.ts`
- ✅ Store rebind on address select retains lines and reports issues — `select_address_for_order`
- ⏳ Out-of-stock substitution offers — deferred (ADR 0003, no customer substitute contract)

## Support and refunds
- ✅ Refund request → support ticket after approval; never worded as approved — live-eval `refund-request` + policy text tests
- ✅ Escalation creates a sanitised ticket — `escalate_to_human` tool
- ✅ Order not found / not owned → `ORDER_NOT_FOUND` / `RESOURCE_NOT_FOUND` (owner-checked reads) — `get_order_details`, tracking tool
- 📄 Refund execution is staff-only (maker-checker) — ADR 0001

## Security and abuse
- ✅ Injection canary in catalog/user text must not be obeyed — live-eval `injection-catalog`
- ✅ Prompt/reasoning never reaches the client — `messageDeltaText` unit tests (reasoning blocks, `thought: true`, `reasoning_content`)
- ✅ Per-user daily turn/token budgets with reservations replaced by reported usage — `AgentRuns`
- ✅ Tool-call cap + duplicate-fingerprint loop breaker — `AgentToolKit`
- ✅ One active run per thread (Redis lease), abort on disconnect/cancel flag — `AgentRuntime.acquire`
- ✅ Cross-user thread/draft access → 404 — `test/integration/agent/confirmation.spec.ts`
- ✅ Consent revoked / flag off → fail closed inside every write transaction — `test/integration/agent/confirmation.spec.ts`

## Nudges
- ✅ Opt-in only; weekly cap; 7-day dedupe; cart and active-order suppression; global flag gate — `test/unit/agent/nudges.spec.ts` + `test/integration/agent/nudges.spec.ts`
- ⏳ Auto-stop after N ignored nudges — not implemented (no interaction feedback loop yet; `ignored_count` column reserved)
- ⏳ Quiet hours — applied by the notifications pipeline for PROMOTIONAL class (unit-covered there; not re-tested end to end)

## Reliability and UX
- ✅ Repeated `clientMessageId` replays stored result — `AgentRuns.begin` + runtime replay path
- ✅ History trimmed at the newest customer message; tool chains stay complete; notes never dropped — `test/unit/agent/middleware.spec.ts`
- ⏳ Client resync after dropped stream — client `refresh()` exists (`agent.tsx`); needs Expo Go walkthrough validation
- ⏳ Retention purge + account erasure incl. checkpoints — wired (`privacy.ts`, compliance worker); integration pass pending
