# App configuration

Owns the typed settings and feature-flag catalog needed by the implemented phases.
Missing settings use validated defaults and flag defaults are disabled.
Setting writes validate both the individual value and cross-setting constraints.
Only an active workforce super-admin may change a setting or feature flag.
Updates serialize, increment versions, and commit audit and configuration history together.
Reads compare database versions on every request so a lost invalidation cannot leave a stale cached value.
The required rider document list is non-empty and cannot contain duplicates.
Future-phase pricing, dispatch and other business settings must be introduced with their owning phases.
Evidence: `test/integration/identity` and the typed configuration schema.
