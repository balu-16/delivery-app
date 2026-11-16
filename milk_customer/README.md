# DairyDirect customer app

An Expo/React Native customer app. The customer API runs on your computer and uses the AWS resources configured in `../server/.env`; Docker is not required. The phone must be able to reach the computer on the same network.

## Start the API

1. Use pnpm **12.18.0**. The command below runs the existing compiled server with Node.js **26.13.0** through pnpm. Configure AWS credentials locally (for example, an AWS CLI profile) and the existing server's `.env` with its database, cache, Cognito and other AWS settings. Verify the intended identity with `aws sts get-caller-identity`. Never put AWS credentials in this app's `EXPO_PUBLIC_*` variables.
2. From the project root, run:

   ```sh
   cd server
   pnpm install --frozen-lockfile
   APP_ROLE=customer \
     READINESS_TIMEOUT_MS=15000 DB_ACQUIRE_TIMEOUT_MS=30000 HTTP_REQUEST_TIMEOUT_MS=30000 HTTP_HEADERS_TIMEOUT_MS=30000 \
     pnpm dlx node@26.13.0 --env-file=.env dist/main.js
   ```

   Keep this terminal open. If `dist/main.js` is absent or older than the server source, obtain permission before compiling it; the existing artifact can be used for the initial sign-in test when it contains the current bootstrap implementation. Check `/healthz` and `/readyz` on the port set in `server/.env` (13080 in the example). The first checks the process; the second checks its configured dependencies. This customer role does not run background workers or consume shared queues. Fulfilment, dispatch, scheduled subscriptions and notifications require the appropriate backend worker processes to be running separately.

## Start on a phone

1. Install Expo Go compatible with Expo SDK 58 on your Android or iOS phone. Put your phone and computer on the same network.
2. In `milk_app`, copy `.env.example` to `.env.local` if it does not exist. Leave `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_API_PORT` empty for local development. Expo supplies the computer's current LAN address, and the app reads the port configured in `server/.env` when Metro starts. Set the public Cognito region and customer app-client ID to match the server. Public Expo variables are included in the app bundle and must not contain secrets.
3. Run:

   ```sh
   cd milk_app
   pnpm install --frozen-lockfile
   pnpm start --go --lan
   ```

4. Open the QR code with Expo Go on Android, or with the iPhone camera. After changing networks, restart Metro and reconnect to the new QR code; no IP address needs editing. If it cannot connect, check firewall access to the Metro and API ports, VPN routing, and that both terminals are running. The phone location permission is used when you choose **Use current location** for an address.
5. Run `pnpm phone:check` in `milk_app` to check the discovered LAN address, API health and readiness, and Metro. A 503 readiness result means at least one configured dependency did not respond within the server's deadline; retry and investigate the AWS connection if it persists.

Automatic discovery assumes Metro and the backend run on the same computer. Restart Metro after changing the backend's `PORT`. If the backend is elsewhere, set `EXPO_PUBLIC_API_URL` to its reachable address; releases require HTTPS. If you override the backend's port on the command line instead of using `server/.env`, set `EXPO_PUBLIC_API_PORT` to the same port before starting Metro. An Expo tunnel only reaches Metro, so a separate reachable API URL is required with `--tunnel`.

Creating an account contacts Cognito directly. Signing in additionally requires the customer API above; an Expo Go screen can load even when that API is stopped. Verified customers are assigned the `CUSTOMER` Cognito group; a new account can appear briefly under **Users** while the group is being assigned. Protected requests require both that group and the matching database customer profile, which is created during bootstrap. For an account with a temporary password, enter that password at sign-in and then choose a new one when prompted.

## Current integration and checks

The app uses Cognito sign-in and the customer API for address selection, catalog and favorites, cart and offers, cash-on-delivery checkout, order history and tracking, referrals, wallet history, inbox, profile and support. Pending checkout and any existing subscription requests are saved on the device and retried with their original idempotency keys. Prices, serviceability and delivery progress come from the backend. Subscription creation is hidden while it is not offered.

Online payment and maps are marked as in progress. To add a delivery address, use the phone-location button while at the address and enter the remaining details. Availability depends on the configured service zones and stores. There is no wallet top-up flow.

Wallet and cash-on-delivery availability depend on the feature flags and each store's COD setting. An active workforce **SUPER_ADMIN** can enable the wallet, enable COD at each store, then enable the global COD flag with the audited admin API. With an up-to-date compiled server, the following helper performs those changes through the authenticated admin API. It prompts for the workforce email, password and, if requested, a verification code; do not share those credentials in chat:

```sh
cd server
pnpm dlx node@26.13.0 --env-file=.env scripts/enable-customer-features.mjs
```

The command requires a real Cognito-backed workforce account with the matching `SUPER_ADMIN` Cognito group and database role. It leaves subscription settings unchanged. COD remains subject to store availability, order value and backend eligibility rules. Referral rewards require the wallet flag.

## Android push notifications

The inbox works in Expo Go. Android push registration, permission prompts, foreground alerts, token refresh and sign-out cleanup are implemented for an Android development build. This project is linked to an Expo project, and its `development` build profile uses the `GOOGLE_SERVICES_JSON` file environment variable for the matching Firebase Android app. The file is also present locally as an ignored `google-services.json`; it is application configuration, while the Firebase service-account credential stays on the server. The EAS secret file must be configured for any other Expo project or environment used to build the app.

After installing a development build, start Metro with `REACT_NATIVE_PACKAGER_HOSTNAME=<your-LAN-IP> pnpm start --dev-client --lan`, sign in, and enable delivery alerts under Notifications. A backend worker with the notifications consumer must be running against the intended queues and FCM project for delivery. The customer-only API does not process those queues. Android remote push requires a real device and a development build; Expo Go does not support it. iOS currently has the in-app inbox but is not registered for remote push, because the backend expects FCM registration tokens. See the [Expo notifications documentation](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/).

The Expo project lives inside a larger repository. **Do not run a development build until the Expo Go test has been completed and the account owner explicitly approves it.** Once approved, submit only the customer app by creating an isolated build directory from the project root. This uses the project's remote `development` environment and does not upload the server, the rider app, local environment files or the local Firebase configuration:

```sh
TASK_BUILD_DIR=$(mktemp -d)
rsync -a --exclude=node_modules --exclude=.expo --exclude='.env*' \
  --exclude=google-services.json --exclude=GoogleService-Info.plist \
  --exclude=android --exclude=ios --exclude=package-lock.json --exclude=references \
  milk_app/ "$TASK_BUILD_DIR/"
ln -s "$PWD/milk_app/node_modules" "$TASK_BUILD_DIR/node_modules"
cd "$TASK_BUILD_DIR"
EAS_NO_VCS=1 eas build --platform android --profile development
```

The build service requires an Expo account and may consume its build quota. Do not upload the server's Firebase service-account credentials to the mobile app or its build archive.

The current development catalog's products all reference an image object missing from the configured S3 bucket. Upload and register the actual product photos through the catalog administration flow to display them. Until then the app shows labelled generic dairy illustrations where available and a neutral placeholder for other products.

Run `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm test` in this directory. To refresh generated API types after backend contract changes, run `pnpm openapi:export` in `server` and then `pnpm api:generate` here.
