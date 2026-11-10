# DairyDirect Partner demo

A standalone Expo frontend with fictional delivery data. No backend is needed. Offers, maps, signal loss and sync, customer contact, proof, cash, UPI, support, location and SOS are simulated. The SOS control does not call emergency services or alert anyone.

```bash
cd delivery_partner_app
pnpm install --frozen-lockfile
pnpm exec expo start --go
```

Scan the QR code with an Expo Go version compatible with SDK 58. Choose **Online**, open **Route**, start the route and check the pickup items. The profile screen provides language, haptics, simulated signal loss, demo clock and reset controls. Route activity and drafts are stored locally on the device.

For checks, run `pnpm test`, `pnpm exec expo lint`, and `pnpm exec tsc --noEmit`. The local rider adapter uses types generated from the checked-in rider OpenAPI document. Multi-stop route and hub workflows are demo-only extensions; live integration would need additional backend capabilities and production handling of private data and device permissions.

The app is a demonstration and must not be used for actual deliveries, payments, location sharing, or emergency response.
