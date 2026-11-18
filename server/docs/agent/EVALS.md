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
  refund request, wallet question). Usual order records the order ids first and then requires
  exactly one new confirmed order for the signed-in customer, with the newest delivered
  quantity, the current catalog price, and the home address, including a repeated approval.
- One request at a time, 2.5 s pacing (tunable). The SDK retry count for this run is 0.
  A rate-limit response stops the suite immediately. Two scenarios that record a provider
  error also stop it. The command compiles with `tsc` before booting, because `tsx` does not
  emit the decorator metadata Nest needs.
- JSON report per run: `artifacts/agent-evals/<provider>-<ts>.json` with per-scenario pass/fail,
  tool sequences, cards, first-event/first-text/total latency, and the transcript text.
- The direct NVIDIA trial endpoint forbids personal or confidential data; Google's free tier may
  use prompts to improve products. Only the fabricated fixture above is ever sent.
