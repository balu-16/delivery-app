# Delivery platform

The repository contains three separate projects:

- [`server/`](server/README.md) — NestJS backend, database migrations, local services, tests, and backend documentation.
- [`milk_app/`](milk_app/) — Expo / React Native customer app.
- [`delivery_partner_app/`](delivery_partner_app/README.md) — standalone delivery-partner frontend demo.

## Run the backend

```bash
cd server
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm migrate
pnpm seed
pnpm start:dev
```

The backend requires the Node and pnpm versions specified in `server/.nvmrc` and `server/package.json`. For a fresh setup, copy `server/.env.example` to `server/.env` before starting. See the [backend setup guide](server/README.md#local-setup) for provider and service configuration.

## Run the mobile app

```bash
cd milk_app
pnpm install --frozen-lockfile
pnpm exec expo start --go
```

Open the displayed QR code with an Expo Go installation compatible with the app's Expo SDK. The mobile app currently uses local demo data.

## Run the delivery-partner demo

```bash
cd delivery_partner_app
pnpm install --frozen-lockfile
pnpm exec expo start --go
```

This app uses fictional local data and does not connect to the backend. Its SOS, calls, payments and location are simulated.
