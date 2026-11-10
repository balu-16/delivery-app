# 0004: Local identities and Cognito provisioning

Date: 6 November 2026. Status: accepted for P1 implementation.

## Context

Local journeys require a working identity provider without AWS credentials. Production verifies Cognito access tokens; customer bootstrap alone verifies an ID token. A workforce creation response may be lost after Cognito creates the user.

## Decision

The local adapter keeps a persistent development identity directory and issues short-lived audience/token-use-bound HS256 tokens with an explicitly local secret. Existing local user state remains authoritative after JWT verification. The development issuer is unavailable with a real provider or in production. Development fixtures, seeds and documentation clearly identify these accounts as local.

For Cognito workforce provisioning, use an operation-derived stable username and configure the workforce pool to permit an immutable username with e-mail sign-in alias. A pool using e-mail as `UsernameAttributes` has different username semantics and must not be assumed to support this convention. Verify the actual owner-created pool mode before activation. Keep customer/workforce identity separate by `(pool,sub)` and `(pool,normalized_email)`.

Persist provisioning progress and reconcile the stable provider username after unknown outcomes. Local role/account checks enforce revocation independently of stale token groups. Role changes are bound to an immutable maker-checker action policy and current actors' permissions; HTTP callers never choose a weaker checker role.

## Consequences

Fixtures and adapter contract tests establish local behavior; live Cognito setup and permissions are separate owner-run acceptance. Record required pool aliases/app clients/groups/MFA and IAM permissions in final handoff. [Cognito attribute modes](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html) and [token verification](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html) are the provider references.
