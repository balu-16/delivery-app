# Addresses

Owns customer contact addresses and the default-address invariant.
Coordinates, pincode and E.164 contact data are validated before persistence.
Every query filters by owner and excludes soft-deleted records.
Mutations lock the owning user before changing addresses.
When any active address remains, exactly one is the default.
Updates require the current version; stale updates return a conflict.
Geocoding mismatch/degraded state is explicit and never silently rewrites a pin.
Order/subscription snapshots and invalid-address compensation integrate in later phases.
Evidence: serviceability unit/integration tests and the seeded foundation journey.
