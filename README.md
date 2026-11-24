# Delivery platform

The repository contains these projects:

- [`server/`](server/README.md) — NestJS backend, database migrations, local services, tests, and backend documentation.
- [`milk_admin/`](milk_admin/README.md) — admin portal (stores, catalog, approvals, workforce, campaigns, settings).
- [`milk_store/`](milk_store/README.md) — full store operations frontend for store managers.
- [`milk_customer/`](milk_customer/README.md) — Expo / React Native customer app.
- [`delivery_partner_app/`](delivery_partner_app/README.md) — Expo delivery-partner app connected to the rider backend.
- [`server/store_manager_web/`](server/store_manager_web/README.md) — smaller store client for picking and rider reviews (kept API-compatible; use `milk_store` for feature acceptance).

## Run the backend with the existing AWS services

Configure `server/.env` for Cognito, Aurora, Valkey and the other AWS services. Connect to the network that can reach the Aurora endpoint; no Docker daemon is needed for this setup. Follow the [AWS development guide](server/docs/local-aws-development.md) for the credential profiles and provider settings.

```bash
cd server
pnpm install --frozen-lockfile
PORT=13080 pnpm start:dev
```

The backend requires the Node and pnpm versions specified in `server/.nvmrc` and `server/package.json`. A fresh `.env.example` uses local providers and must be configured for AWS before starting. Apply migrations only to the intended database after checking the deployment steps; do not seed an existing environment without reviewing the data changes.

## Run the admin portal

```bash
cd milk_admin
pnpm install --frozen-lockfile
pnpm dev
```

See the [admin portal setup](milk_admin/README.md).

## Run the customer app

```bash
cd milk_customer
pnpm install --frozen-lockfile
pnpm exec expo start --go --lan
```

The customer app connects to the backend for shopping and account data. Configure its API and Cognito settings; Android push notifications require a development build. See the [customer app setup](milk_customer/README.md).

## Run the delivery-partner app

```bash
cd delivery_partner_app
pnpm install --frozen-lockfile
pnpm exec expo start --go --lan
```

Expo Go supports sign-in and application testing. A native development build, the configured backend, and an approved rider profile are required for delivery shifts; see the [partner app setup](delivery_partner_app/README.md).

## Run the store-manager portal

Use the full store operations frontend:

```bash
cd milk_store
pnpm install --frozen-lockfile
pnpm dev
```

See the [store portal guide](milk_store/README.md). The smaller
[store client](server/store_manager_web/README.md) covers picking and rider
reviews only.
