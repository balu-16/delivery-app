# DairyDirect store operations

This local React portal lets a store manager review rider applications for their assigned stores and claim, pick, pack and hand over orders. An administrator provisions the manager and assigns at least one store. The manager cannot review riders from another store, and each required document must be approved before a rider can make deliveries.

## Run locally

Use Node 26.13.0 and pnpm 12.18.0. Start the configured backend with its store surface and workers (`APP_ROLE=all` for both mobile and store testing), and ensure its database migrations and Cognito group synchronization have been applied to the intended environment. The example API URL uses port 13080, matching the phone setup. Follow [the backend setup](../README.md). The default local browser origin is `http://localhost:5173`; add the actual origin to the backend's `CORS_ALLOWED_ORIGINS` if it differs.

```sh
cd server/store_manager_web
pnpm install --frozen-lockfile
test -f .env.local || cp .env.example .env.local
pnpm dev
```

Set `VITE_API_URL` to the reachable API base URL, `VITE_COGNITO_REGION` to the pool region, and `VITE_COGNITO_CLIENT_ID` to the public **store** app client. These values are exposed to the browser: never put an AWS credential or Cognito client secret here. A production-hosted portal requires an HTTPS API and a corresponding allowed origin. `.env.local` is ignored by Git. The portal has not been deployed by these instructions.

Sign in using the manager's invited account. A temporary password prompts for a new password. The browser keeps the session in memory, so refreshing the page requires signing in again. To review a rider, choose the assigned store, open **Rider applications**, inspect each document, and approve it or request a replacement with a reason. A signed document link is temporary and private.

Use **Orders & picking** to claim a task, record picked or unavailable items, complete the pick, pack the order and verify the rider's handover code. Stock and order state are provided by the backend; availability and authorization are checked again when an action is submitted.

## Check

```sh
pnpm typecheck
```

The API models in `src/store-api.generated.ts` are generated from the store OpenAPI document. Regenerate them after changing its contracts and test the portal against the intended backend before deploying it.
