# Assistant evaluations

Two modes:

## Deterministic (default, no keys)

```
pnpm test                    # unit project: fake model, guards, middleware, nudges
pnpm test:int -- --testPathPatterns agent
AWS_PROFILE=default AWS_CONFIG_FILE= AWS_P13_INTEGRATION=yes \
  node --env-file-if-exists=.env --experimental-vm-modules node_modules/jest/bin/jest.js \
  --selectProjects integration --runInBand --testPathPatterns agent
```

The integration suites run on a disposable `delivery_p13_*` Aurora database created via IAM
(`test/helpers/services.ts`); nothing touches Docker or a local database.

## Live provider comparison (synthetic data only)

```
AWS_PROFILE=default AWS_CONFIG_FILE= AWS_SHARED_CREDENTIALS_FILE= AWS_P13_INTEGRATION=yes \
  pnpm agent:evals:live --provider nvidia            # or --provider google
# optional: --filter <regex> to run one scenario, --pace <ms> to widen pacing
```

- Boots the real app (`APP_ROLE=customer`, `AGENT_ENABLED=true`, `LLM_THINKING=on`) inside a
  disposable fixture database seeded with synthetic customers, catalog and orders — never real
  customer data.
- 14 scenarios per provider (quick order EN/TE/Tenglish, usual order, ambiguity, tracking EN/TE,
  cancel approve/reject, out-of-scope top-up, catalog injection canary, address-less customer,
  refund request, wallet question). Assertions check tool usage, cards, drafts **and resulting
  database state** (one order, correct quantity, cancelled/unchanged status, ticket created,
  wallet untouched).
- One request at a time, 2.5 s pacing (tunable), 15 s backoff retry on a provider error, and a
  hard stop after three consecutive failures to respect provider rate limits.
- JSON report per run: `artifacts/agent-evals/<provider>-<ts>.json` with per-scenario pass/fail,
  tool sequences, cards, first-event/first-text/total latency, and the transcript text.
- The direct NVIDIA trial endpoint forbids personal or confidential data; Google's free tier may
  use prompts to improve products. Only the fabricated fixture above is ever sent.
