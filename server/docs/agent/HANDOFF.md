# Customer assistant handoff (work in progress)

The assistant is not ready to enable or deploy. Both `AGENT_ENABLED` and the remote `agent_enabled` flag default off. No production migration, model credential, native build, or EAS build has been applied for this work.

## What is present

- Customer chat and streaming client, English/Hindi/Telugu strings, server-owned cards, consent, conversation deletion, and a feature-gated Home entry.
- A pinned LangChain/LangGraph runtime with an intentionally limited scripted fake model. The fake is a test double; it does not provide general natural-language understanding.
- Customer-owned product, cart, order, wallet, and support tools, plus code for confirmation-gated checkout and cancellation. These reuse the existing domain contracts; online payments, map selection, wallet top-up and subscription activation remain unchanged.
- Additive migration `050_customer_agent.sql`, an explicit checkpoint-schema setup command, and agent-data cleanup hooks. These have not been applied to the application database.

## Work required before launch

1. Complete and review the remaining capabilities from `customer-app-agent-prompt.md`: typed-address continuation and serviceability, robust interrupted-run recovery, refund-request confirmation, subscription tools that respect the existing flag, reorder/recipes/substitutions/coupon/policy tools, and opt-in nudges. Add bounded conversation trimming, prompt-injection defenses, cost accounting, evaluation scenarios and the remaining accessibility/UX flows.
2. Fix the AWS Organizations policy that explicitly denies `rds-db:connect` and `elasticache:Connect` for the development test role. Retry the isolated Aurora and Valkey integration suite, including migration, runtime grants, consent revocation, account erasure, race conditions, duplicate requests, expired drafts, checkout, cancellation and reconnect recovery. Do not use customer data as test fixtures.
3. Regenerate and validate the customer OpenAPI contract and client types after the API is finalized. Finish lint, typecheck, unit, integration and security checks on AWS.
4. Test the feature in Expo Go against the development server. Only after that testing and the owner's explicit approval may a native or EAS build be started.
5. In a separately reviewed deployment, run the application migration, run `pnpm agent:checkpoints` with the appropriate migration identity, and apply runtime grants. Confirm backup, rollback and retention behavior before setting a real provider and enabling both feature switches.

## AWS test constraint

The existing AWS test role can run ephemeral Lambda checks, but the organization policy denies IAM database/cache connections. The attempted Aurora test stopped at authentication, before creating a disposable database. No local database, Docker, or local test runner is used for this work.
