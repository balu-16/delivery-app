# DairyDirect Partner

The partner app uses Cognito email/password accounts and the rider API for applications, shifts, offers, deliveries, earnings, cash, notifications, and support. Delivery and cash actions require a connection. Uncertain requests retain an idempotency key so a retry does not create a new action.

## Configure and run

```bash
cd delivery_partner_app
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Set `EXPO_PUBLIC_COGNITO_REGION` and `EXPO_PUBLIC_COGNITO_CLIENT_ID` in `.env.local`. For local development, leave `EXPO_PUBLIC_API_URL` empty: the app takes the computer's current LAN address from the Expo development server and uses port `13080`. If the backend uses another port, set `EXPO_PUBLIC_API_PORT` once to match it. Use `EXPO_PUBLIC_API_URL` for an explicit remote backend; release builds require an HTTPS URL. These values are public app configuration; never put AWS credentials, a Cognito client secret, or a Firebase service-account key in the app.

Run the backend with the rider and store surfaces and the worker processes enabled (`APP_ROLE=all` locally, or the corresponding separate roles). Apply its migrations to the intended non-production database first. Configure PostgreSQL/PostGIS, Redis/queues, the workforce Cognito pool and rider client, the `RIDER` Cognito group, and private media storage. The identity worker needs permission to add the pending rider to that group. See [the backend setup](../server/README.md) before starting services or migrations.

For example, after configuring the backend, run `APP_ROLE=all PORT=13080 pnpm start:dev` from `server`. Run Metro with `--lan` on the same computer and connect the phone to the same network. When the address changes, restart or reconnect to the Expo development server; no IP address needs updating in the app. Automatic discovery assumes Metro and the backend run on the same computer. An Expo tunnel reaches Metro only, so use an explicit reachable backend URL when the backend is elsewhere or accessed through a separate tunnel.

Background location and Android push require a native development build; Expo Go cannot provide the complete shift workflow. With the native Android toolchain installed, create and run a local development build with `pnpm exec expo run:android`, then start Metro with `pnpm exec expo start --dev-client --lan`. An iOS development build needs the corresponding Apple development environment. Web can be used for sign-in and application review, but cannot go online as a rider.

For Android push, register `com.dairydirect.partner` in the same Firebase project used by the backend, and set `GOOGLE_SERVICES_JSON` to that app's Firebase configuration file when creating the native build. Configure the backend with `PUSH_PROVIDER=fcm` and its server-only Firebase service-account credential, and run the notifications worker. Enable delivery alerts in Profile after signing in. The iOS app has the inbox and foreground updates; iOS remote push is not configured.

The Cognito pool must allow self-service signup, email verification, `USER_AUTH` password sign-in, refresh and revocation. Its public rider client must expose the verified email, subject, and name in ID tokens. The app supports temporary-password changes; unsupported challenges are reported. Native refresh tokens stay in SecureStore and refreshes are serialized across foreground and background runtimes. Web sessions stay in memory. No passwords, delivery codes, or customer details are placed in the action retry store.

## Applications and reviews

After email verification, signing in creates a pending rider application. The rider selects a store and supplies vehicle details and the configured required documents. All required documents must be approved by a manager assigned to that store before operational access is enabled. A rejected document can be replaced in the app. The current development pool can be shared with the customer app; identities are linked by verified pool subject, never by matching email alone. Conflicting identities require manual review.

Documents can be uploaded from Expo Go as JPEG, PNG or PDF files up to 5 MB each. Once a store, vehicle details and every required document are submitted, the application moves to review. Uploading a document does not approve it.

The assigned manager can use the [store operations portal](../server/store_manager_web/README.md) or the protected store API:

1. List `GET /v1/store/rider-applications?storeId=<store-id>&status=UNDER_REVIEW` using the store client.
2. Read `GET /v1/store/rider-applications/{userId}` and obtain each current document using `GET /v1/store/rider-documents/{documentId}/read-url`. Signed URLs are temporary private credentials; do not place them in logs or shared messages.
3. Submit `POST /v1/store/rider-documents/{documentId}/review` with `{ "approved": true, "reason": "" }`, or set `approved` to `false` and provide a reason. The backend approves the application only after every required document is approved.

Store managers use the same portal to pick and pack orders and verify the rider's displayed handover code before pickup. A cash deposit is recorded by store staff, not by the rider app.

## Shift behavior

Going online requests foreground and background location permission and starts location updates with the system's background indicator. Tracking stops on going offline or signing out. Operating systems may suspend updates after a force-stop or other interruption; the app reports interrupted tracking and the backend marks stale riders unreachable. An active delivery stays subject to the backend's custody rules. Optimized multi-stop routes, payout requests, schedules, and SOS are unavailable.

## Checks

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
```

Database integration tests require the backend's isolated PostGIS and Redis test services. Provider acceptance additionally requires a non-production Cognito account, private storage, Firebase configuration, and physical Android/iOS devices. Do not point test helpers or seeds at a production database.
