# Customer assistant discovery

The assistant is a customer-only surface. It runs with the authenticated customer identity, uses existing domain contracts, and is disabled by default. It must not use staff-only operations or create another source of commerce rules.

## Tool and integration map

| Requested tools or flow | Existing owner | Integration or gap |
| --- | --- | --- |
| Product search and ingredient matching | `CATALOG_QUERY.list` | Requires an owned serviceable address; return bounded store-scoped results. Ingredient matching is orchestration over this read. |
| Cart read, absolute quantity, clear and coupons | `CART_SERVICE` | Writes need the current cart version. Report clamped quantities; never silently discard unrelated lines. |
| Address list, create and select | `ADDRESSES`, `CART_SERVICE` | Address creation currently has no transaction/idempotency reference and no label. Add those capabilities in the address domain before exposing confirmed creation. |
| Address validation and serviceability | `ADDRESSES`, `SERVICEABILITY`, `MAPS` | Geocoding may be unavailable. Capture coordinates explicitly through the existing customer location flow; never derive coordinates from model output. |
| Quote and place order | `CHECKOUT` | Quote persists an expiring snapshot and intent; it is not a pure read. Placement requires the existing idempotency owner/operation and may resume after a crash. |
| Recent orders, reorder, cancel and timeline | `ORDERS` | Filter by customer. Cancellation must use an approved draft and join the existing idempotency transaction. Reorder must not silently replace a nonempty cart. |
| Tracking | customer tracking contracts | Return only the customer's permitted tracking details. |
| Policy answers | app configuration / policy texts | There is no complete configured customer policy source yet; add an owned, validated text source and report unavailable content honestly. |
| Missing/damaged/late issue and human escalation | `SUPPORT.create` | Supports a durable `reference` for deduplication; sanitize summaries. |
| Refund request | `SUPPORT.create` | Refund execution contracts are staff-only. Create a support request after approval; never promise or issue a refund. |
| Subscriptions and schedule | `SUBSCRIPTIONS` | Existing contracts handle create, read, schedule and changes. Respect `subscriptions_enabled` and wallet flags; add an atomic multi-date skip in the owning module. |
| Wallet summary | `WALLET_VIEWS` | Read only; no top-up entry point. |
| Coupons and substitutes | `COUPONS`, catalog/picking data | Add customer-safe read contracts in the owning domains for actual eligible savings and in-stock, no-more-expensive substitutes. |
| Reorder nudges | notifications and order history | Add an opt-in scheduled job, localized templates, suppression and deduplication. Existing notification preferences and IST quiet hours apply. |

## Customer integration

- `components/connected/Catalog.tsx` owns the Home header. Expo Router supplies the new chat route; the existing API client resolves the development host dynamically.
- The current app has no general i18n dictionary. Add a typed assistant dictionary for English, Hindi and Telugu.
- The current address form captures the phone's location and normalizes Indian phone numbers. Maps and online payments are marked as under development; wallet top-up is absent. Preserve these choices.
- The customer API type file is generated from `server/openapi/customer.json`; update the public API and regenerate it.

## Security and operational gaps

- Existing consent types cover terms and privacy only. Add a versioned AI consent with read and revoke operations, enforced before model access.
- Persist thread and draft ownership in SQL, keep audit details free of personal content, and integrate checkpoint cleanup into retention and account erasure.
- LangGraph interrupts may replay their node. Draft creation and every post-approval side effect must be idempotent; checkout must reuse the existing operation claim rather than invent a second one.
- No model credentials are available. The fake model is a scripted test double, not general multilingual intelligence. Live language quality requires separate provider evaluation.
- Existing integration helpers can use `TEST_DATABASE_URL` and `TEST_REDIS_URL`. Use isolated local services instead of Docker or the paused AWS database. The local Node installation must meet the server's declared Node 26 requirement.
