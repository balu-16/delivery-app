# Backend handoff

P0–P12 have local phase acceptance. P13 hardening is in progress; its security criterion inventory and load results must be completed before declaring local P13 acceptance. PROGRESS.md is the source of measured results. No hosted CI, staging load, credentialed provider acceptance or deployment is implied.

## Local operation

Use Node 26.13.0 and pnpm 12.18.0 with the frozen lockfile. README.md contains the clean local setup. Development defaults select local authentication, fake payments/maps/push, local storage and SMTP. Run migrations before seeding; seeds refuse production. Never run fixture writers or destructive service-recovery tests against an existing application database.

One image serves `APP_ROLE=all|customer|rider|store|admin|worker`. Audience processes expose only their routes; workers own durable recovery and maintenance. Mount writable private storage and a bounded temporary directory when running with a read-only root. Export workers spool bounded CSV attempts to temporary storage before uploading. Persist local media if retaining local application data; tmpfs is appropriate only for disposable tests.

Use different migration and runtime database logins. Provision the runtime role without superuser, role/database creation, replication, bypass-RLS attributes, inherited elevated roles or schema ownership. Run `scripts/grant-runtime.ts` as the migrator after each schema upgrade, with `MIGRATION_DATABASE_URL` and `RUNTIME_DATABASE_ROLE`. Review its grants before deployment. Partition maintenance functions require their restricted EXECUTE grants; runtime does not need general DDL. Production down migrations are prohibited.

Migrations 029 and 030 reject down migration in every environment. Upgrade them before replacing application processes. Quotes created by earlier versions lack the pricing fingerprint and require a fresh quote; handle the existing `PRICE_CHANGED` response by refreshing rather than resubmitting an old snapshot. Inventory/cache revision changes no longer imply a price change. Keep database restoration and application compatibility rehearsals separate from destructive down migrations.

## Provider configuration and owner resources

| Provider | Required owner setup and verification |
|---|---|
| Cognito | Separate customer/workforce pools, audience-specific app clients, documented email-alias mode, groups, workforce MFA and runtime provisioning permissions. Verify bootstrap, current-role revocation, ambiguous provisioning recovery and pool-correct erasure against these resources. |
| S3/CDN | Distinct media/private buckets, region, workload IAM, browser upload CORS and private CloudFront origin access. Test immutable promotion, conditional copy/write enforcement, private signed reads, multipart abort and erasure on actual buckets. |
| Razorpay | Selected real provider, production key ID/secret, webhook secret and owner webhook routing. Test exact raw-body signatures, checkout verification, ambiguous creates, refund idempotency/reconciliation and settlement visibility. Do not use test-mode keys in production. |
| Ola | Owner API key, verified configured endpoint paths, routing/matrix quotas, timeout and degradation tests. Fixture response tests do not verify account access or billing. |
| SES/SMTP | Verified sender/domain, appropriate sending access and runtime IAM or SMTP credentials. Check bounce/failure behavior and absence of customer PII in diagnostics. |
| FCM | Owner project/service-account secret, application token configuration and invalid-token cleanup. Test real device delivery separately from provider fixture behavior. |

All variable names/defaults are listed in `.env.example` and the environment manifest. Production validation rejects local/fake selections, placeholders and local endpoints. Store secrets in the deployment secret mechanism, use workload credentials for AWS, and never upload load fixture token files with public CI reports. Configure CORS, operational metrics bearer authentication, database/Redis URLs and current fulfillment-code key versions per environment.

## Recovery and operational review

Use RUNBOOK.md for queue/outbox replay, payment ambiguity, custody, subscription retries, payout corrections and privacy cleanup. PostgreSQL stores business obligations; Redis recovery may replay delivery, so preserve dedupe records. Do not clear processed identities or rewrite money/stock state to repair a failed job. Backups must include schema, financial records, media metadata and private objects; rehearse restoration on isolated infrastructure, verify reconciliation, then run controlled recovery before reopening traffic.

Observe readiness, database pool pressure, queue/outbox backlog, errors and retry saturation. Sum connection budgets across process replicas and leave administrative headroom. Load reports must include actual role/process counts and service limits. Readiness failures can remove an instance from routing; design the ingress degradation policy deliberately instead of assuming cache-independent reads remain reachable.

Rotate fulfillment secrets by adding a new version, selecting it for new codes and retaining old versions until their live references expire. Rehearse token/JWKS rotation and runtime secret replacement in staging. Graceful shutdown must drain bounded work; forced termination relies on durable claims and lease recovery.

## Money, privacy and scale acceptance

Payouts and manual customer refunds do not initiate bank transfers. Record actual external payment references and private evidence only after payment; maker-checker, source caps, COD offsets and compensating corrections remain mandatory. Review tax rates, HSN/GST rules, invoice/credit-note handling, wallet promotions, privacy retention, legal holds and erasure policy with the owner before production activation.

Run the full staging dataset and original targets documented in the P13 ADR and load README. Retain percentiles, errors, saturation, resource settings and reconciled ledgers. Local smoke thresholds and the historical single-wallet failure remain separate evidence. Hosted CI must run from an actual repository remote; a workflow file or local equivalent is not a hosted pass.

Before activation, the owner must complete staging scale, provider contracts, IAM/resource configuration, restore rehearsal and legal-policy review, and record responsible owner, date and evidence for each. Leave unavailable checks pending. Application deployment is a separate authorized action.
