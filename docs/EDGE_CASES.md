# Edge-case implementation and test register

Source: Section 34 of [delivery-platform-agent-prompt.md](../delivery-platform-agent-prompt.md). Companion: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

All **52 source checklist items** are reproduced below, in source order, with stable IDs, owning phases, and proposed test cases. The original tables preserve the full-project test targets. Actual P0–P4 evidence is linked below; compound requirements remain open until their later-phase assertions also pass. Proposed identifiers are design targets, not links to nonexistent files.

Record actual file links and named Jest cases alongside the targets, and record local or hosted CI evidence explicitly. Do not mark an item complete merely because its endpoint exists. Concurrency tests use independent DB connections and synchronization barriers; failures and restarts use deterministic fault injection rather than arbitrary sleeps.

## Current P0–P4 evidence

The consolidated local run and its tool/service versions are recorded in [PROGRESS.md](PROGRESS.md). These suites run against real PostgreSQL/PostGIS and Redis where I/O is involved. Provider fixtures are not live-provider acceptance.

| Register items | Actual evidence | Remaining scope |
|---|---|---|
| CON-09 | [Outbox recovery](../test/integration/platform/outbox-recovery.spec.ts): `recovers publish-before-ack crash, then applies DB effect once`; `recreates a lost Redis job even after successful enqueue acknowledgement`; independent fan-out and stale-ack fencing. | Foundation case verified locally; future consumers need their own business-effect tests. |
| CON-02 | [Idempotency concurrency](../test/concurrency/platform/idempotency.spec.ts): same-key serialization, permanent fencing after response pruning, expired lease versus an active mutation lock. | Checkout/order uniqueness requires P6. |
| ADD-01, ADD-02 | [Primitives](../test/unit/platform/primitives.spec.ts): bigint serialization and safe conversion; [role isolation](../test/integration/runtime/real-roles.spec.ts): all six roles boot with actual dependencies and only intended routes; [raw-body ingress](../test/integration/runtime/raw-body.spec.ts). | Actual gateway amounts and socket role loading require P6/P8. |
| GEO-01, GEO-02 | [Zone/address/capacity integration](../test/integration/serviceability/zone-address.spec.ts): polygon/boundary validation, overlaps/snapshots, default races, competing capacity claims, auto-pause; [hours](../test/unit/serviceability/hours.spec.ts): overnight/holiday/exact close buffer. | In-flight order snapshots and real dispatch/backlog producers require P6–P8. |
| GEO-03, ADD-09 | [Maps contracts](../test/unit/serviceability/maps.spec.ts): published Ola envelopes/methods/parameters, breaker and cached/haversine degradation, pin mismatch; [serviceability](../test/unit/serviceability/serviceability.spec.ts): coordinate-only decisions. | Live Ola acceptance and order-address mutation require external resources/P6. |
| GEO-04, ADD-10 | [Contact policy](../test/unit/serviceability/contact.spec.ts), [address validation](../test/unit/serviceability/hours.spec.ts), [private KYC media](../test/integration/identity/private-media.spec.ts), [S3 KYC metadata/signing](../test/integration/catalog/s3-private.spec.ts): owner/type/size/capability/reviewer restrictions. | Task endpoint integration and POD/exports require P8/P12; credentialed S3 activation remains external. |
| SEC-01 | [Cognito token verification](../test/unit/identity/cognito-token.spec.ts): RS256 signatures, issuer/pool/client/use/expiry, missing groups and rotating JWKS; [guard tests](../test/unit/identity/identity-guard.spec.ts). | Live Cognito resources remain untested. |
| SEC-02, SEC-03 | [Identity integration](../test/integration/identity/identity.spec.ts): blocked bootstrap and stale-role revocation; [permission matrix](../test/integration/identity/permission-matrix.spec.ts): all 22 protected P1 operations; [HTTP journey](../test/e2e/foundation-journey.spec.ts): all current routes deny unauthenticated access, DTO/owner/store checks. | Later resource types, sockets and every permitted-role response remain phase-specific work. |
| SEC-04 | [Identity saga](../test/integration/identity/identity.spec.ts): lost create response, failed compensation/retry, ordered provider sync; [identity concurrency](../test/concurrency/identity/identity-concurrency.spec.ts): last super-admin and maker-checker races/expiry. | Live Cognito provisioning acceptance remains untested. |
| PAY-11, SEC-06 | [Production configuration](../test/unit/runtime/env.spec.ts), [distributed rate limits](../test/integration/platform/rate-limit.spec.ts), [structured redaction](../test/unit/runtime/logging.spec.ts). | Coupon/search/location business abuse cases require their later phases. |
| TIM-02, TIM-04, OPS-01, OPS-02 | [Concern queues](../test/integration/platform/concern-queues.spec.ts), [outbox recovery](../test/integration/platform/outbox-recovery.spec.ts), [database recovery](../test/integration/platform/database-recovery.spec.ts), [populated migration upgrade/rollback](../test/integration/platform/migration.spec.ts), adapter breaker tests. | Later schedulers, true database failover and complete P13 resilience/load acceptance remain open. |
| SEC-05, OPS-03, SYS-08 | [Identity integration](../test/integration/identity/identity.spec.ts) covers retry-safe erasure requests and audited typed config; [outbox rollback](../test/integration/platform/outbox-recovery.spec.ts) and zone/store integration cover atomic state/event writes. | Erasure execution and legal retention require P12; cross-domain config snapshots and all aggregate invariants require later phases. |
| INV-03, INV-05, ADD-11 | [Catalog integration](../test/integration/catalog/catalog.spec.ts): store-scoped eligibility, publication/history/event rollback, temporal price/approval, ranking, cursor pages and Redis boundary expiry; [imports](../test/integration/catalog/import.spec.ts): BOM/encoding/duplicates/limits, dry-run, cross-admin replay, published SKU updates, approval replacement and lease loss; [queue/reports](../test/integration/catalog/queue-report.spec.ts): lost hints and private report recovery. | Cart quote invalidation/checkout revalidation require P5/P6. |
| CON-01, CON-08, INV-01, INV-02, ADD-12, SYS-01 | [Inventory concurrency](../test/concurrency/inventory/reservation.spec.ts): 100 attempts against ten units yield exactly ten successes; missing-line rollback, opposite ordering, target FEFO/shelf life, HELD/COMMITTED expiry, release/pick races, batch/ledger reconciliation, damaged shortage obligations and QC-bounded returns. | Checkout and customer financial compensation integrate these contracts in P6/P7. |
| CON-10, OPS-01, OPS-03, ADD-24 | [Inventory concurrency](../test/concurrency/inventory/reservation.spec.ts): current-role/store checks, manual/count approvals and immutable replay, expected-version shelf-life settings, small-pool count execution and scoped cursor traversal. | General admin repairs remain P12; no arbitrary force-state endpoint is implemented. |
| SEC-03, ADD-10 | [Media registration/cleanup](../test/integration/catalog/media.spec.ts) and [storage contracts](../test/unit/catalog/storage.spec.ts): immutable content, claim fencing, provider failure/retry and safe S3 copy conditions; [HTTP journey](../test/e2e/foundation-journey.spec.ts): real seeded image/catalog, ETags and authentication denial across all current audience routes. | Moto HTTP smoke cannot prove AWS conditional-copy enforcement; live AWS/CDN acceptance remains separate. |

## Concurrency and consistency

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| CON-01 | Two users buy the last unit simultaneously → exactly one succeeds | P4, P6 | `inventory-reservations.conc` :: `last_unit_has_one_winner`; `hundred_requests_reserve_only_ten_units` |
| CON-02 | Same user double-taps "Place order" / retries after timeout → one order (idempotency) | P0, P6 | `checkout-idempotency.conc` :: `double_submit_creates_one_order`; `crash_after_commit_resumes_existing_order` |
| CON-03 | Cancel and payment-capture arrive together → serialised, consistent final state | P6 | `payment-cancel.conc` :: `capture_then_cancel`; `cancel_then_capture_refunds_once` |
| CON-04 | Cancel and pick-complete race; cancel and rider pickup race | P7, P8 | [Pick cancel/complete race](../test/concurrency/picking/claim.spec.ts) :: `cancel_and_pick_complete_serialize_into_one_consistent_terminal_state` (rider-pickup half is P8) |
| CON-05 | Two riders accept one offer; rider accepts after expiry | P8 | `dispatch-accept.conc` :: `one_assignment_wins`; `expired_offer_cannot_assign` |
| CON-06 | Modify subscription vs generation job race | P10 | `subscription-generation.conc` :: `schedule_mutation_serializes_with_generation` |
| CON-07 | Concurrent wallet spends from two devices; coupon over-redemption | P5, P6 | `wallet-spend.conc` :: `balance_never_negative`; `coupon-quota.conc` :: `global_and_per_user_limits_hold` |
| CON-08 | Deadlock on multi-item reservation (sorted lock order) and automatic retry | P0, P4 | `inventory-locks.conc` :: `reversed_inputs_use_sorted_locks`; `deadlock_retry_is_bounded_and_side_effect_free` |
| CON-09 | Outbox relay crash after publish before mark-published (consumer idempotency) | P0 | `outbox-recovery.int` :: `publish_ack_crash_replays_one_business_effect` |
| CON-10 | Optimistic-lock conflicts return `409 CONCURRENT_MODIFICATION` | P0, P5 | `aggregate-version.api` :: `stale_version_has_stable_problem_code` |

## Payments and money

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| PAY-01 | Webhook duplicate / out-of-order / delayed / missing (poller recovers) | P6 | `payment-events.int` :: `duplicate_is_noop`; `failed_then_captured_is_paid`; `stale_failure_cannot_unpay`; `poller_recovers_missing_capture` |
| PAY-02 | Webhook arrives before the create-order response is persisted | P6 | `payment-events.int` :: `early_webhook_waits_for_attempt_mapping` |
| PAY-03 | Amount or currency mismatch; tampered client amount; replayed webhook with changed body | P6 | `payment-security.api` :: `amount_currency_mismatch_quarantined`; `client_total_is_untrusted`; `event_id_changed_body_rejected` |
| PAY-04 | Payment captured after order expired/cancelled → refund or reinstate per config | P6 | `late-capture.int` :: `default_source_refund_once`; `configured_reinstatement_rechecks_stock_capacity` |
| PAY-05 | User pays twice for one order → second auto-refunded | P6 | `duplicate-capture.conc` :: `one_capture_funds_order_other_is_refunded` |
| PAY-06 | Gateway outage / timeout on create-order and on refund | P6 | `gateway-ambiguity.int` :: `known_failure_is_retryable`; `timeout_after_success_reconciles_before_retry`; `refund_retries_use_same_vendor_key` |
| PAY-07 | Refund exceeding captured; repeated refund requests; refund failure retries | P6 | `refund-limits.conc` :: `pending_and_processed_refunds_reserve_cap`; `same_intent_refunds_once`; `failed_refund_recovers` |
| PAY-08 | Partial wallet + gateway, reversal on failure | P6 | `funding-allocation.int` :: `gateway_failure_restores_original_cash_promo_once` |
| PAY-09 | Zero-total order; COD over cap; COD ineligible; COD amount mismatch | P6, P8 | `checkout-methods.api` :: `zero_due_skips_gateway`; `cod_caps_and_eligibility`; `cod-mismatch.int` :: `mismatch_requires_resolution` |
| PAY-10 | Rounding: discount allocation sums exact; GST per line; credit note after shorts | P5–P7 | `pricing.property` :: `allocation_and_tax_reconcile`; `inclusive_tax_not_added_twice`; `invoice-adjustments.int` :: `short_before_issue_adjusts_invoice`; `short_after_issue_creates_credit_note` |
| PAY-11 | Test-mode keys refused in production | P0, P6 | `production-config.unit` :: `razorpay_test_keys_fail_boot` |

PAY-10 follows plan decision D19: before invoice issuance, shorts adjust the future invoice; a credit note is required when an issued invoice is corrected.

## Inventory and catalog

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| INV-01 | Reservation expiry sweep releases stock; late payment after sweep | P4, P6 | `reservation-expiry.int` :: `expired_hold_releases_once`; `committed_reservation_survives_sweep`; `capture_after_release_refunds` |
| INV-02 | Shortage at pick; all items short; damaged/expired batches; FEFO order | P4, P7 | [Picking integration](../test/integration/picking/picking.spec.ts) :: `shorts_mark_the_remainder_completion_consumes_picked_stock_and_reports_the_adjustment_once`; [fulfillment](../test/integration/picking/fulfillment.spec.ts) :: `an_all_short_task_goes_through_the_shared_cancel_routine_and_never_completes`, `fefe_suggestions_order_by_earliest_expiry_and_exclude_expired_batches` (damaged/quarantined exclusion reuses the P4 eligibility filter) |
| INV-03 | Item unpublished or price changed while in cart → flagged, never silently altered at payment | P3, P5, P6 | `cart-quote.api` :: `unpublished_item_is_issue`; `price_change_requires_confirmation`; `checkout_revalidates_price_version` |
| INV-04 | Store switch on address change re-evaluates cart | P5 | `cart-store-change.api` :: `unavailable_lines_retained_as_issues_and_new_prices_confirmed` |
| INV-05 | Import: duplicate SKUs, bad GST, BOM/encoding, huge file, re-run idempotency | P3 | `catalog-import.int` :: `duplicate_and_tax_validation`; `bom_utf8_and_size_limits`; `repeat_real_import_is_noop`; `dry_run_does_not_suppress_real_run` |

## Serviceability and addresses

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| GEO-01 | Point on zone boundary; overlapping zones with priority; zone edited mid-order | P2, P6 | `serviceability.int` :: `covers_boundary`; `priority_then_distance_tie_break`; `order_keeps_zone_snapshot` |
| GEO-02 | Store overnight hours, holiday, last-order buffer, capacity limit, auto-pause | P2, P6, P8 | `store-availability.unit` :: `overnight_holiday_and_buffer`; `store-capacity.conc` :: `claim_limit_is_atomic`; `store-autopause.int` :: `backlog_or_no_riders_pauses_new_orders` |
| GEO-03 | Maps provider down; geocode vs pin mismatch; address change after placing order | P2, P6 | `maps-degradation.api` :: `cached_or_haversine_fallback`; `pin_mismatch_needs_confirmation`; `order-address.api` :: `only_same_zone_same_fee_before_picking` |
| GEO-04 | Missing contact phone; phone visibility window for riders | P2, P8 | `address-contact.api` :: `required_e164_phone`; `rider-contact.api` :: `assigned_rider_only_during_active_contact_window` |

## Dispatch and delivery

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| DSP-01 | No rider available (radius widening, admin alert, auto-cancel threshold) | P8 | `dispatch-recovery.int` :: `widen_backoff_alert_then_configured_cancel` |
| DSP-02 | Rider silent before vs after pickup; app crash/reinstall resume; rider suspended mid-task | P8 | `rider-custody.int` :: `before_pickup_redispatch`; `after_pickup_escalate`; `current_task_restores_session`; `suspension_preserves_custody` |
| DSP-03 | Mock GPS, teleport, stale or out-of-order points, oversized batches | P8 | `location-ingest.api` :: `integrity_policy_for_mock_accuracy_teleport`; `newer_point_wins`; `future_skew_and_batch_limits` |
| DSP-04 | Wrong handover code; wrong delivery code attempts limit; contactless proof-of-delivery | P7, P8 | [Handover verification](../test/integration/picking/fulfillment.spec.ts) :: `handover_verification_is_attempt_limited_lockable_and_manager_override_is_audited`; delivery-code attempts and contactless POD are P8 |
| DSP-05 | Customer unreachable / wrong address / failed delivery → RTO → QC → restock | P7, P8 | `failed-delivery.e2e` :: `wait_contact_fail_return_qc_resellable_or_damage` |
| DSP-06 | Cash-in-hand limit blocks COD offers; settlement discrepancies | P8, P11 | `rider-cash.int` :: `cod_assignment_checks_current_cash_limit`; `deposit_discrepancy_is_audited`; `payout_nets_dues_once` |

## Realtime and notifications

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| RTN-01 | Socket reconnect resumes via snapshot; unauthorised room join rejected; location visible only in the allowed window | P8 | `tracking-sockets.int` :: `reconnect_snapshot_on_another_instance`; `other_owner_join_denied`; `terminal_event_revokes_live_location`; `http_fallback_matches_snapshot` |
| RTN-02 | Duplicate notification suppressed; invalid FCM token cleanup; locale fallback; promotional quiet hours | P9 | `notifications.int` :: `recipient_channel_event_dedupe`; `invalid_token_deactivated`; `english_fallback`; `quiet_hours_only_promotional` |
| RTN-03 | Notification failure never breaks order flow | P9 | `notification-failure.e2e` :: `order_delivers_while_channel_is_unavailable` |

## Identity and security

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| SEC-01 | Expired / wrong-pool / wrong-client / tampered tokens; JWKS rotation; clock skew | P1 | `auth-contract` :: `token_rejection_matrix`; `unknown_kid_refresh_once`; `configured_skew_boundary`; `id_vs_access_audience_validation` |
| SEC-02 | Blocked user with valid token; role removed mid-session | P1, P8 | `authorization-revocation.int` :: `blocked_valid_token_denied`; `stale_group_cannot_restore_removed_role`; `socket_expiry_and_revocation` |
| SEC-03 | IDOR attempts on every resource type; wrong-role access on every surface | P1–P12 | `operation-permission-matrix.api` :: generated cases for every scoped operation: `other_owner_404`; `other_store_404`; `wrong_role_403`; `wrong_surface_401` |
| SEC-04 | Workforce user saga failure and compensation; last SUPER_ADMIN protection | P1 | `identity-saga.int` :: `db_failure_compensates_and_resumes`; `compensation_failure_is_recoverable`; `last_super_admin_survives_concurrent_demotion` |
| SEC-05 | Erasure blocked by active order/subscription; anonymisation keeps legal records | P1, P12 | `account-erasure.e2e` :: `active_obligations_block`; `balance_requires_resolution`; `pii_removed_legal_links_retained`; `cognito_failure_retries` |
| SEC-06 | Rate limit and abuse scenarios (coupon guessing, search spam, location flooding) | P0, P5, P8 | `rate-limits.api` :: `per_actor_route_class_limits`; `distributed_limit_across_instances`; `retry_after_and_bounded_payloads` |

## Time and scheduling

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| TIM-01 | Cutoff boundaries (21:00 IST exact second), financial-year rollover (31 Mar → 1 Apr) for invoice sequences | P6, P10 | `subscription-cutoff.unit` :: `before_exact_at_after_cutoff`; `invoice-sequence.int` :: `fy_changes_at_ist_midnight` |
| TIM-02 | Cron run twice / late / crashed midway (idempotent) | P0, P4, P6, P10 | `scheduler-recovery.int` :: parameterized scheduler suite `duplicate_late_crashed_run_preserves_business_uniqueness` |
| TIM-03 | Month-end, leap-year schedule maths; start date after cutoff | P10 | `subscription-calendar.unit` :: `month_end_leap_year_and_frequency_anchors`; `after_cutoff_selects_next_eligible_unlocked_date` |
| TIM-04 | Clock skew between app instances (single source: DB time or injected Clock for critical decisions) | P0, P6, P8, P10 | `critical-clock.int` :: `host_skew_cannot_change_expiry_offer_or_cutoff_decision` |

TIM-01/TIM-03 follow plan decision D23: the next day's delivery is locked at the configured cutoff, including the exact cutoff instant.

## Operations

| ID | Source checklist item | Phases | Planned suite :: case(s) |
|---|---|---|---|
| OPS-01 | Graceful shutdown mid-job; DLQ replay; migration applied on live data | P0, P13 | `shutdown-replay.int` :: `interrupted_job_replays_once`; `drain_timeout_recovers`; `migration-upgrade.int` :: `populated_previous_schema_remains_consistent` |
| OPS-02 | Redis outage degraded behaviour; Postgres failover reconnect; adapter circuit breaker open/half-open | P0, P6, P8, P13 | `dependency-failure.int` :: `redis_read_fallback_and_ingest_503`; `db_reconnect_and_safe_retry`; `breaker_open_half_open_recovery`; `durable_work_rebuilds_after_redis_loss` |
| OPS-03 | Config change takes effect without redeploy and is audited | P1, P12 | `runtime-config.int` :: `all_roles_invalidate_cache`; `schema_relationships_validated`; `money_snapshot_stays_frozen`; `audit_diff_has_no_secrets` |

## Additional tests introduced by the plan

These cover gaps that are not separate source Section 34 bullets. Their full-project targets remain planned; any current partial evidence is explicitly linked above.

| ID | Phase | Proposed test and required result |
|---|---|---|
| ADD-01 | P0 | `bigint-wire.contract` :: values round-trip as decimal strings; unsafe gateway-number conversion fails before sending. |
| ADD-02 | P0 | `role-route-isolation.api` :: all six roles boot; audience routes/gateways and webhook ingress appear only on intended roles; worker has only internal operational endpoints. |
| ADD-03 | P0 | `outbox-fanout.int` :: one queue failing during fan-out does not lose another consumer's delivery or apply an effect twice. |
| ADD-04 | P0 | `idempotency-lease.conc` :: crash recovery/fencing cannot steal a live mutation or create a second business operation after cache expiry. |
| ADD-05 | P1 | `pool-email.int` :: identical normalized email is allowed across pools, unique within a pool; users never merge. |
| ADD-06 | P1 | `bootstrap-onboarding.api` :: missing-profile bootstrap and pending-rider document submission work without relaxing operational guards. |
| ADD-07 | P1 | `maker-checker.conc` :: self-approval, expired/version-changed payload and duplicate execution fail; successful approval executes the original use case exactly once. |
| ADD-08 | P2 | `address-default.conc` :: create/default/delete races leave exactly one default when any active address remains. |
| ADD-09 | P2 | `maps-cost.contract` :: matrix calls use only configured top-K; repeated GPS pings trigger no unbounded directions/matrix calls. |
| ADD-10 | P3 | `private-media.api` :: another actor cannot register/read KYC, POD or private exports; content/size/purpose restrictions are enforced. |
| ADD-11 | P3–P4 | `catalog-stock-bridge.int` :: P3 zero-stock assortment is visible as out of stock; P4 receipt adds matching on-hand and ledger balance. |
| ADD-12 | P4 | `perishable-allocation.conc` :: expired/quarantined/short-shelf-life stock cannot be promised; batch allocation reconciles with aggregate stock. |
| ADD-13 | P6 | `refund-allocation.conc` :: concurrent pending refunds and wallet reversals cannot refund more than funded or restore the same bucket twice. |
| ADD-14 | P6 | `invoice-issue.conc` :: rollback consumes no committed document number; rendering failure reuses the issued number and immutable payload. |
| ADD-15 | P6 | `delivery-code.int` :: authorized code retrieval survives process restart/key rotation, stores no plaintext, and attempt lockout remains effective. |
| ADD-16 | P7 | [Substitution race](../test/concurrency/picking/claim.spec.ts) :: `substitution_cannot_oversell_exactly_one_contending_reservation_wins`; [guards and reconciliation](../test/integration/picking/fulfillment.spec.ts) :: `substitution_guards_fail_closed_and_a_listed_swap_reconciles_reservations` (charge cap executes through the P6 adjustment contract). |
| ADD-17 | P8 | `geo-expiry.int` :: expired rider hash/stale heartbeat excludes a remaining GEO member from assignment. |
| ADD-18 | P8 | `rider-capacity.conc` :: one rider accepting two different tasks cannot exceed configured task or COD cash limits. |
| ADD-19 | P8 | `location-sampling.int` :: timestamp ordering is atomic across ingest instances; 15-second OR 50-metre sampling and partition rollover work. |
| ADD-20 | P9 | `notification-transition.int` :: same delivery retry dedupes, but a distinct valid transition/version can notify again; ambiguous provider sends are tracked. |
| ADD-21 | P10 | `generation-target-slot.int` :: closed-now/open-at-delivery store is evaluated correctly; slot capacity/reservations survive the ordinary payment TTL. |
| ADD-22 | P10 | `subscription-occurrence.conc` :: occurrence conflict rolls back debit, stock and coupon changes; each skipped/retried date has one durable outcome. |
| ADD-23 | P11 | `payout-allocation.conc` :: duplicate batches/mark-paid retries never pay the same earning twice; negative net dues carry forward explicitly. |
| ADD-24 | P12 | `admin-repair.int` :: approved force-state repair preserves stock, financial and custody invariants; raw arbitrary status writes are unavailable. |

## Section 12 invariant ownership

| ID | Invariant | Enforcement and planned evidence |
|---|---|---|
| SYS-01 | No overselling; `0 ≤ reserved ≤ on_hand` | Inventory constraints + atomic sorted reservation; CON-01, CON-08, INV-01, ADD-12. |
| SYS-02 | Inventory and wallet ledgers match balances | Transactional ledger/balance writes and reconciliation assertions after each test journey; CON-07, INV-02, PAY-08, ADD-11, ADD-13. |
| SYS-03 | Order totals reconcile to the paisa | Pure bigint quote/allocation and frozen fulfillment adjustment model; PAY-10, ADD-01, ADD-16. |
| SYS-04 | Applied funding is unique and refunds do not exceed captured funds | Canonical capture/refund commitments under order locks; PAY-05, PAY-07, ADD-13. Additional external captures are detected/refunded per D18. |
| SYS-05 | One active rider per task and bounded tasks per rider | Conditional task assignment plus rider capacity locks; CON-05, ADD-18. |
| SYS-06 | At most one active delivery and pick task per order | Unique order/task keys and idempotent confirmation consumers; [pick half](../test/integration/picking/picking.spec.ts) :: `the_confirmation_consumer_creates_exactly_one_task_per_order_with_walk_ordered_items`; delivery half is P8. |
| SYS-07 | Coupon limits never exceeded | Locked global/user quota counters and reversible redemption records; CON-07 and P5 50-attempt/10-use concurrency test. |
| SYS-08 | State/history/event persist together | Shared transition transaction and rollback tests across aggregates; CON-03, CON-04, CON-09 and P0 transition integration suite. |
| SYS-09 | Gapless unique issued invoice numbers, immutable documents | Counter/document insertion in one transaction, immutable grants, out-of-transaction rendering; TIM-01, ADD-14. |
| SYS-10 | One subscription order per delivery date | Unique occurrence inserted in the order/debit/reservation transaction; CON-06, TIM-02, ADD-22. |

## Sign-off rules

At each phase gate, link completed cases to actual tests and record the CI run/commit in PROGRESS.md. At P13, verify all 52 source rows, all 24 additional rows, all ten invariants, and the separate per-operation permission manifest. A skipped or quarantined mandatory test does not count as passing. Live provider acceptance remains separately labeled until it is exercised against owner-provided resources.
