# Delivery platform

The repository contains three separate projects:

- [`server/`](server/README.md) — NestJS backend, database migrations, local services, tests, and backend documentation.
- [`milk_app/`](milk_app/) — Expo / React Native customer app.
- [`delivery_partner_app/`](delivery_partner_app/README.md) — Expo delivery-partner app connected to the rider backend.
- [`server/store_manager_web/`](server/store_manager_web/README.md) — store-manager portal for picking and rider reviews.

## Run the backend with the existing AWS services

Configure `server/.env` for Cognito, Aurora, Valkey and the other AWS services. Connect to the network that can reach the Aurora endpoint; no Docker daemon is needed for this setup. Follow the [AWS development guide](server/docs/local-aws-development.md) for the credential profiles and provider settings.

```bash
cd server
pnpm install --frozen-lockfile
PORT=13080 pnpm start:dev
```

The backend requires the Node and pnpm versions specified in `server/.nvmrc` and `server/package.json`. A fresh `.env.example` uses local providers and must be configured for AWS before starting. Apply migrations only to the intended database after checking the deployment steps; do not seed an existing environment without reviewing the data changes.

## Run the mobile app

```bash
cd milk_app
pnpm install --frozen-lockfile
pnpm exec expo start --go --lan
```

The customer app connects to the backend for shopping and account data. Configure its API and Cognito settings; Android push notifications require a development build. See the [customer app setup](milk_app/README.md).

## Run the delivery-partner app

```bash
cd delivery_partner_app
pnpm install --frozen-lockfile
pnpm exec expo start --go --lan
```

Expo Go supports sign-in and application testing. A native development build, the configured backend, and an approved rider profile are required for delivery shifts; see the [partner app setup](delivery_partner_app/README.md).

## Run the store-manager portal

Configure its public store Cognito client and API URL as described in the [portal guide](server/store_manager_web/README.md), then:

```bash
cd server/store_manager_web
pnpm install --frozen-lockfile
pnpm dev
```
