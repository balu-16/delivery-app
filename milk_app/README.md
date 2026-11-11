# DairyDirect customer app

An Expo/React Native customer app. The customer API runs on your computer and uses the AWS resources configured in `../server/.env`; Docker is not required. The phone must be able to reach the computer on the same network.

## Start the API

1. Use pnpm **12.18.0**. The command below runs the server with Node.js **26.13.0** through pnpm. Configure AWS credentials locally (for example, an AWS CLI profile) and the existing server's `.env` with its database, cache, Cognito and other AWS settings. Verify the intended identity with `aws sts get-caller-identity`. Never put AWS credentials in this app's `EXPO_PUBLIC_*` variables.
2. From the project root, run:

   ```sh
   cd server
   pnpm install --frozen-lockfile
   pnpm build
   # Replace this with your computer's Wi-Fi address.
   LAN_IP=192.168.1.100
   APP_ROLE=customer PORT=13080 APP_BASE_URL="http://${LAN_IP}:13080" \
     READINESS_TIMEOUT_MS=15000 DB_ACQUIRE_TIMEOUT_MS=30000 HTTP_REQUEST_TIMEOUT_MS=30000 HTTP_HEADERS_TIMEOUT_MS=30000 \
     pnpm dlx node@26.13.0 --env-file=.env dist/main.js
   ```

   Keep this terminal open. Check `http://localhost:13080/healthz` and `http://localhost:13080/readyz`. The first checks the process; the second checks its configured dependencies. This customer role does not run background workers or consume shared queues. Fulfilment, dispatch, scheduled subscriptions and notifications require the appropriate backend worker processes to be running separately.

## Start on a phone

1. Install Expo Go compatible with Expo SDK 58 on your Android or iOS phone. Put your phone and computer on the same network. Find your computer's LAN IPv4 address, for example using `ip -4 addr` on Linux.
2. In `milk_app`, copy `.env.example` to `.env.local`. Set `EXPO_PUBLIC_API_URL` to `http://<computer-LAN-IP>:13080`; `localhost` on a phone means the phone itself. Set the public Cognito region and customer app-client ID to match the server. Public Expo variables are included in the app bundle and must not contain secrets. Restart Metro after changing them.
3. Run:

   ```sh
   cd milk_app
   pnpm install --frozen-lockfile
   # Replace this with the same Wi-Fi address used in .env.local.
   REACT_NATIVE_PACKAGER_HOSTNAME=192.168.1.100 pnpm start --go --lan
   ```

4. Open the QR code with Expo Go on Android, or with the iPhone camera. If it cannot connect, check the LAN IP, firewall access to the Metro and API ports, VPN routing, and that both terminals are running. The phone location permission is used when you choose **Use current location** for an address.

## Current integration and checks

The app uses Cognito sign-in and the customer API for address selection, catalog and favorites, cart and offers, cash-on-delivery checkout, order history and tracking, referrals, wallet history, inbox, profile and support. Pending checkout and any existing subscription requests are saved on the device and retried with their original idempotency keys. Prices, serviceability and delivery progress come from the backend. Subscription creation is hidden while it is not offered.

Online payment and maps are marked as in progress. To add a delivery address, use the phone-location button while at the address and enter the remaining details. Availability depends on the configured service zones and stores. There is no wallet top-up flow.

In the configured AWS development database, the wallet and cash-on-delivery flags are disabled and the three stores have COD disabled. An active workforce **SUPER_ADMIN** can enable the wallet, enable COD at each store, then enable the global COD flag with the audited admin API. After the latest server has been built, the following helper performs those changes through the authenticated admin API. It prompts for the workforce email, password and, if requested, a verification code; do not share those credentials in chat:

```sh
cd server
pnpm build
pnpm dlx node@26.13.0 --env-file=.env scripts/enable-customer-features.mjs
```

The command requires a real Cognito-backed workforce account with `SUPER_ADMIN` in the database. The existing development super-admin rows are demo identities. No supported first-admin bootstrap procedure is currently provided, so the account owner must establish one before this command can succeed. It leaves subscription settings unchanged. COD remains subject to store availability, order value and backend eligibility rules. Referral rewards require the wallet flag.

## Android push notifications

The inbox works in Expo Go. Android push registration, permission prompts, foreground alerts, token refresh and sign-out cleanup are implemented for an Android development build. This project is linked to an Expo project, and its `development` build profile uses the `GOOGLE_SERVICES_JSON` file environment variable for the matching Firebase Android app. The file is also present locally as an ignored `google-services.json`; it is application configuration, while the Firebase service-account credential stays on the server. The EAS secret file must be configured for any other Expo project or environment used to build the app.

After installing a development build, start Metro with `REACT_NATIVE_PACKAGER_HOSTNAME=<your-LAN-IP> pnpm start --dev-client --lan`, sign in, and enable delivery alerts under Notifications. A backend worker with the notifications consumer must be running against the intended queues and FCM project for delivery. The customer-only API does not process those queues. Android remote push requires a real device and a development build; Expo Go does not support it. iOS currently has the in-app inbox but is not registered for remote push, because the backend expects FCM registration tokens. See the [Expo notifications documentation](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/).

The Expo project lives inside a larger repository. To submit a development build with only the customer app, create an isolated build directory from the project root. This uses the project's remote `development` environment and does not upload the server, the rider app, local environment files or the local Firebase configuration:

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
