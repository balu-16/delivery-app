# Existing product constraints

- The assistant is disabled unless both the environment and remote setting enable it. The fake provider is for development and tests only.
- Online payments and maps remain unavailable to customers. No wallet top-up is added. The subscription skill respects the existing feature flags without enabling them.
- Address location comes from an explicit device action; typed text alone does not provide trusted coordinates. A missing geocoder must be disclosed, not simulated.
- A customer refund request creates a support ticket, not a staff-authorized refund. A confirmation previews the request and does not promise an outcome.
- Test on AWS only, using the existing development services and isolated, disposable test data. Do not use a local database, local test runners or Docker. Do not start a native or EAS build before Expo Go testing and explicit approval.
