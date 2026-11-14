# DairyDirect Admin — REFACTOR Build Contract (spec: "Admin sidebar", 14 sections)

You are building pages inside an existing React 18 + TS + Vite + Tailwind app that was just
refactored to a NEW domain (stores/products/orders/payments/approvals). The foundation
(types, seed, store, api, hooks, shell, generic components) is DONE and typechecks.
Build your assigned pages EXACTLY per the spec sections quoted below. Do NOT rebuild
infrastructure; consume the hooks/components listed here.

## Golden rules
1. The spec is the single source of truth. No features beyond it, no stubs, no placeholders.
2. UI state is driven by RECORD FIELDS (status, canApprove, eligible, causeFixed...) — never
   hardcoded assumptions. Eligible actions disabled with a reason tooltip otherwise.
3. Every number computed from the seeded dataset. Indian formatting via `fmtINR/fmtCompactINR/fmtNum`
   from `@/lib/utils`. Demo clock: `DEMO_NOW` = 24 Jan 2026 11:05 AM (`timeAgo(x, DEMO_NOW)`).
4. Do NOT modify shared files (anything outside your page files) — another agent works in
   parallel. Small helpers go INSIDE your page file.
5. Keep animations: `useStagger()` variants (container/item) from `@/hooks/misc`, `KpiCard`
   count-ups, `hoverable` Cards, `TabPills`, `RangeToggle`, DataTable skeletons, Drawer slide-ins.
6. Run `npx tsc --noEmit` and fix only errors in YOUR files.
7. Feature flags: `useFeature('cod'|'wallets'|'subscriptions')` + `useFeatureFlags()` from
   `@/hooks/flags`. Subscriptions flag OFF → Subscriptions page shows the disabled banner.
   Wallets OFF → wallet UI hidden. COD OFF → COD fields/columns hidden.

## Data hooks — `@/hooks/queries`
- `useDashboard(range, storeId)` → DashboardSummary (§1 type in src/types/index.ts)
- `useStores() useStore(id) useZones() useCities() useLegalEntities()`
- `useProducts(filters{search,categoryId,brandId,state,page,pageSize})` → { rows: {product, variants[], storeCount, minPrice, maxPrice}[], total, categories, brands }
- `useVariants(productId?) useStoreVariants(variantId?) useStock(filters) useMovements(filters) useStockBatches()`
- `useOrders(filters{search,storeId,customerId,status,range,page,pageSize})` → { rows: {order,storeName,riderName,refundTotal}[], total, counts }
- `useOrderDetail(id)` → { order, store, rider, attempts[], refunds[], tickets[] }
- `useCustomers(filters) useCustomerOrders(customerId) useRiderApplications(filters) useWorkforce(filters)`
- `usePaymentAttempts(filters)` → { rows, total, counts:{captured,failed,initiated} }
- `useRefundList(filters) useWalletLedger(filters) useReconciliation() useInvoiceFailures()`
- `usePayouts(filters)` → { rows, total, counts } · `usePayoutCorrections()`
- `useCoupons() useCampaigns() useAdminNotifications()`
- `useSubscriptionRuns() useSubscriptionConfig()` → { slots, holidays, settings, runs, subscribable }
- `useTickets(filters) useTicket(id) useSavedResponses() useRatings(queueOnly)`
- `useReportPreview(tab) useExportJobs()`
- `useApprovals(filters) useFraudFindings() useErasureRequests() useLegalHolds()`
- `useSystemSettings() useBackgroundJobs() useOperationalNotifications() useStoreOptions() useRiders()`

## Mutation hooks — `@/hooks/mutations` (journal op + toast + invalidate)
- `useStoreActions`: addStore/updateStore/deleteStore/addZone/updateZone/deleteZone/addLegalEntity/updateLegalEntity/deleteLegalEntity
- `useProductActions`: addProduct(product,variants)/updateProduct/deleteProduct/updateVariant/addVariant/updateAvailability(variantId,storeId,patch)/requestApproval({action,targetType,targetLabel,details,reason},{productId?,pendingLabel?})
- `useInventoryActions`: updateStock(storeId,variantId,patch)
- `useOrderActions`: hold(id,reason)/release(id)/cancel(id,reason)/requestCorrection(id,kind,reason)/reassign(id,riderId,riderName)/resolveAddress(id)/resetCode(id)
- `usePeopleActions`: blockCustomer/unblockCustomer/addWorkforce/updateWorkforce/requestPasswordReset/requestRoleChange(member,newRole,approvalId)
- `usePaymentActions`: requestRefund(orderId,amount,reason,source)/updateRefundStatus(id,'processing'|'paid'|'failed')/recordRefundEvidence(id,reference,fileName)/walletAdjust(entry)/setReconciliationStatus(id,status,note?)/retryInvoice(id)
- `usePayoutActions`: approve(payout)/hold(id,reason)/settle(id,reference,fileName?) — settle records evidence AFTER paid, no bank transfer initiated
- `useOfferActions`: addCoupon/updateCoupon/addCampaign/markNotificationRead(id?)
- `useSubscriptionAdminActions`: retryRun(id)/updateConfig(patch)
- `useSupportActions`: reply(ticketId,body,internal?)/setStatus(id,status)/moderate(id,'approved'|'removed',reason?)
- `useApprovalActions`: decide(id,'completed'|'rejected',applyChanges?{variantId,newPrice,publish,workforceId,newRole})/setFraudStatus/updateErasure/placeHold/releaseHold
- `useExportActions`: createJob(tab,label,filtersSummary) → job (auto completes/fails after ~2.2s)
- `useSystemActions`: setFeatures(flags)/setRules(rules)/retryJob(id)

## Eligibility helpers — `@/data/selectors`
`orderActionEligibility(db, order)` → booleans + reason strings for hold/release/cancel/reassign/resolveAddress/resetCode
`isRefundEligible(db, orderId)` → {eligible, reason?} · `orderRefundTotal(db, orderId)`
`getDashboardSummary(db, range, storeId)` · `reportPreview(db, tab)` · `variantLabel(db, vid)` · `storeName(db, sid)`

## Generic components — `@/components/shared/domain.tsx`
- `ApprovalBadge{pendingApprovalId,label?}`
- `StatusTimeline{steps:[{label,at?,note?}|null]}`
- `ExportJobRow{job,onDownload}` — download button only when status==='complete' && authorized
- `ApprovalCard{approval,onDecide}` — approve/reject disabled unless approval.canApprove, shows cannotApproveReason
- `SectionCard{title,subtitle?,action?,children}`
- `ZoneLegend`
- `CsvImportWizard<T>{open,onOpenChange,title,templateHeader,validateRow(rowRecord,index)→T|{row,field,error},onApply(rows),itemNoun?}` — upload → dry run → error table → confirm apply

## Map — `@/components/shared/map/*`
- `LazyMap{center,zoom,markers:[{coords,color,label?,radius?}],polygons:[{points,color,label?}],polyline,origin,destination,liveMarker,showZoom,scrollWheelZoom}`
- `PolygonEditor` (default export; import dynamically: `const PolygonEditor = lazy(() => import('@/components/shared/map/PolygonEditor'))`):
  {center, initialPoints, color, onSave(points), onCancel?} — drag vertices, click map to add.

## UI kit (unchanged)
Button(primary/secondary/outline/ghost/destructive/success · sm/md/lg/pill/icon) · Card(hoverable)/CardHeader/CardTitle/CardContent ·
Input/Textarea/Label/Badge/Kbd/Skeleton/Switch/Checkbox/Progress · Dialog/DialogContent/Drawer/ConfirmDialog/Dropdown*/Popover/Tooltip ·
Select/Field · KpiCard{label,value,format:'num'|'inr'|'compact'|'pct',delta?,deltaGood:'up'|'down'|'none',icon,tint,sparkline?,highlight?,suffix?} ·
DataTable+Pagination+Column{key,header,render?,align?} · PageHeader{title,titleAccent?,subtitle?,illustration?,actions?,breadcrumb?} ·
DateChip/RangeToggle{value,onChange,id}/TabPills{tabs,value,onChange,id}/SearchInput/EmptyState/StatusPill/DeltaText ·
charts: Sparkline/TrendChart/DonutChart/GaugeChart/ComboChart (data: any[])

## Illustrations — `@/illustrations/scenes.tsx`
MeadowScene{variant:'dashboard'|'stores'|'reports'|'settings'|'payments'} · ScooterScene{moving?} · CityScene · StaffScene · OffersScene ·
SidebarScene · FinanceScene · ProductsScene · InventoryScene · PayoutsScene · SupportScene · ApprovalsScene · PeopleScene ·
EmptyIllustration{kind:'box'|'search'|'bell'|'cow404'} · LoginHero. Plus `productIcons.tsx` ProductGlyph/ProductTile{icon,size}, `avatars.tsx` Avatar/InitialAvatar, `Logo.tsx`.

### Page → illustration mapping
Dashboard→MeadowScene('dashboard') · Stores→CityScene · Products→ProductsScene · Inventory→InventoryScene · Orders→ScooterScene ·
People→PeopleScene · Payments→FinanceScene · Payouts→PayoutsScene · Offers→OffersScene · Subscriptions→MeadowScene('settings') ·
Support→SupportScene · Reports→MeadowScene('reports') · Approvals→ApprovalsScene · Settings→MeadowScene('settings')

## Seed facts (all computed — never hardcode)
- 8 stores (6 online: st-1,3,4,5,6,7 · 2 paused: st-2,st-8); Powai Store (st-3) pickingBacklog 38 ("high backlog" ≥30); COD off on st-2.
- 5 cities, 13 zones (priority 1/2/3), 3 legal entities; one manager per store via workforce wf-2..wf-9 (store.managerIds).
- 12 products / 26 variants / 3 brands (DairyDirect Classic, Pasture Fresh, Village Craft) / 5 categories; "Butter" unpublished; products with `pendingApprovalId` show "Pending approval" (seeded approvals ap-1/ap-2/ap-3 are pending price changes on Ghee 500 ml, Cow Milk 1 L, Paneer 500 g).
- 1,248 orders (DD09242…DD10489): statuses delivered ≈982 · in-progress (confirmed/picking/ready) ≈104 · out_for_delivery 62 · placed ≈48 · cancelled ≈34 · on_hold 12; 21 orders `requiresAttention` (attentionReason: on_hold / wrong_address / code_locked / payment_failed).
- Fixed rows: DD10489 delivered (Aditya Deshpande, st-1, ₹420, UPI) · DD10488 out_for_delivery (Meera Kulkarni, st-2) · DD10487 picking (Rutuja Jadhav, st-6, ₹320) · DD10486 delivered (Prateek Nair, st-7, card) · DD10485 picking COD (Nikhil Wagh, st-8) · DD10484 on_hold (st-3) · DD10483 wrong_address (st-3) · DD10482 code_locked (st-4, COD) · DD10481 payment_failed (st-1).
- Payment attempts: gateway only (COD & wallet excluded); 34 recovered orders have a failed attempt #2; payment_failed orders have only a failed attempt.
- Refunds: 24 cancelled-order refunds (17 paid / 3 processing / 2 requested / 2 failed) + ₹120 paid partial on DD10487 + 4 delivered-order requests (2 requested / 2 processing). Render status EXACTLY as stored — never "Paid" for requested.
- Wallet ledger: ~300 top-ups + wallet order payments + refund credits + 5 authorized adjustments (authorizedBy "Arjun Mehta").
- Payouts: 8 active riders × 4 weekly cycles = 48. Current cycle (17–23 Jan): 5 pending_review (canApprove=true), 2 approved, 1 on_hold. Past cycles paid except rider rd-1 latest paid cycle = failed. Corrections/COD offsets seeded (payoutId PO-001…PO-026).
- Coupons: 8 (percentage/flat/free_delivery incl FREEDLY) with eligibleStoreIds/eligibleProductIds. Campaigns: pmc-1 sent, pmc-2 scheduled (Republic Day, selected users), pmc-3 draft.
- Tickets: 20 with messages (some `internal`) and attachments (some authorized=false); 5 saved responses. TCK-2041 ↔ order DD10188. Ratings: 43; moderation queue = moderationRequired && moderationStatus==='pending'.
- Approvals: 6 pending (3 price_change canApprove=true; ap-4 role_change canApprove=FALSE + cannotApproveReason; ap-5 refund_override; ap-6 product_publish), 2 completed, 1 rejected, 1 expired (ap-10, reason given).
- Reconciliation RC-01…06 · Fraud FR-001…05 · Erasure er-1..4 (er-1 eligible, er-2 ineligible: legal hold) · Legal holds LH-1 active, LH-2 released.
- Export jobs ex-1..5 (3 complete w/ authorized download, 1 pending, 1 failed) · Background jobs job-1..6 (5 failed: job-1 canRetry, job-2 canRetry=false w/ note, job-3 requeue canRetry, job-4 canRetry, job-5 skip; 1 running) · Operational notifications 5.
- Inventory: ~170 stock rows, 14 low-stock, ~60 batches (9 expire ≤7 days), ~370 movements (flagged rows: damage/expiry/unusual_adjustment).
- Subscription runs run-01..24: 21 completed, run-23 partial (3 retryable failures), run-14 partial (1), run-08 failed (2 failures); slots slot-1..4; holidays 3; settings {orderCutoffTime '20:00', autoRetryFailed, defaultSlotId}.
- System settings: features {cod:true, wallets:true, subscriptions:true}; rules {deliveryFee 40, freeDeliveryAbove 499, minOrderValue 149, maxOrdersPerSlotPerStore 120, dispatchRadiusKm 6, dispatchBatchSize 8, codMaxOrderValue 5000, walletMaxBalance 10000, refundWindowDays 7, riderRequiredDocs[license,id_proof,bank_details]}.

## Page frame (every page)
PageHeader with breadcrumb + subtitle + mapped illustration + (where useful) DateChip/Select filters; content wrapped in
`<motion.div variants={container.container} initial="hidden" animate="show">` with section children as `variants={container.item}`.

## Your output
Create ONLY the page files you are told to. After writing, run `npx tsc --noEmit` and fix errors in your files only.
Report: files created, spec bullets covered, tsc status, any deviation + why.
