# DairyDirect Store Manager Portal

Standalone React, TypeScript, and Vite frontend for store operations. It talks to the backend in `server` over cookie sessions. Demo data is not used for login, orders, inventory, or other operational screens.

## Run locally

```bash
cd milk_store
npm install
npm run dev
```

Open <http://localhost:5174>. The Vite dev server proxies `/v1` to `http://localhost:13080` (override with `VITE_DEV_API_TARGET`). Sign in with a workforce Cognito user in the `STORE_MANAGER` group that has store assignments in Aurora. A first login with a temporary password completes `NEW_PASSWORD_REQUIRED` on the login screen. Password reset sends a real code to the account email.

Production needs the same `/v1/store` routes on the store origin so the `store_session` cookie stays first-party. The cookie is host-only and `HttpOnly`. State-changing requests send `x-store-csrf`.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Browser coverage uses Playwright (`npm run test:e2e`) against the dev server and the running API. Do not put passwords in the repository. Pass `STORE_E2E_EMAIL` and `STORE_E2E_PASSWORD` only in the local shell when you want the live login spec to run.
