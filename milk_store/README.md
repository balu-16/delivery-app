# DairyDirect Store Manager Portal

A standalone React, TypeScript, and Vite frontend for store operations. It
includes the dashboard, orders and picking, inventory, returns, rider
applications, COD deposits, store status, staff workload, and notifications.

## Run locally

```bash
cd milk_store
npm install
npm run dev
```

Open <http://localhost:5174>. Sign in with the demo store-manager account:

| Email | Password |
| --- | --- |
| `chaitanya.raju@srm.edu.in` | `Store@123` |

Optionally copy `.env.example` to `.env` to prefill that account and show the
demo account panel. `VITE_DEMO_MODE` controls the panel only: the app always
uses demo data, whether or not the variable is set.

## Data and authentication

This frontend is not connected to the admin backend. Authentication, store
assignments, orders, and other data use an in-browser demo dataset. Changes
are saved to browser storage where supported; they do not affect real orders
or the admin application. Password recovery is a visual preview: no email is
sent and the password is not changed. The demo login and its client-side role
checks are not production authentication.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The app uses root-level routes and is intended to run on its own origin or
port. Its required shared frontend code is included in `shared/src`.
