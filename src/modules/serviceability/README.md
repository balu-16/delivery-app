# Serviceability

This module resolves delivery zones and target-slot availability without external maps.
Store, schedule and capacity data remain owned by the stores and serviceability contracts.
Zone membership uses PostGIS `ST_Covers`, priority, then distance and stable IDs.
City and zone versions make cached selections safe after administration changes.
Capacity claims must share the caller's order transaction and use a stable reference.
Maps adapters expose places and bounded routing; degraded routes use haversine estimates.
Address text geocoding may be unavailable without blocking coordinate-based checks.
The disabled call-masking adapter and contact policy are contracts for later delivery work.
Only a currently assigned rider in the documented task states may see delivery contact details.
