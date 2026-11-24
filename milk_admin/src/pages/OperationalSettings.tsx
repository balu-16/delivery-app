import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { batchUpdateConfig, updateConfigKey } from '@/api/settings'
import { Button, Card, Input, Switch } from '@/components/ui/base'
import { Select } from '@/components/ui/form'

type Kind =
  | 'money'
  | 'integer'
  | 'number'
  | 'time'
  | 'boolean'
  | 'enum'
  | 'text'
  | 'stringList'
  | 'numberList'
  | 'codEligibility'

interface Setting {
  key: string
  group: string
  label: string
  hint: string
  kind: Kind
  units?: string
  effect?: string
  options?: string[]
}

/**
 * Typed registry of portal-editable settings: key, group, control, units and
 * effect. Mirrors the server ConfigValues schema (server config-service).
 */
const settings: Setting[] = [
  // ── Checkout and fees ──
  { key: 'maxCodPaise', group: 'Checkout and fees', label: 'Cash on delivery limit', hint: 'Maximum cash due on one order', kind: 'money', units: '₹', effect: 'Checkout' },
  { key: 'freeDeliveryThresholdPaise', group: 'Checkout and fees', label: 'Free delivery from', hint: 'Qualifying order value', kind: 'money', units: '₹', effect: 'Checkout' },
  { key: 'handlingFeePaise', group: 'Checkout and fees', label: 'Handling fee', hint: 'Fee applied to an order', kind: 'money', units: '₹', effect: 'Checkout' },
  { key: 'smallCartThresholdPaise', group: 'Checkout and fees', label: 'Small order threshold', hint: 'Orders below this value may have a small-order fee', kind: 'money', units: '₹', effect: 'Checkout' },
  { key: 'smallCartFeePaise', group: 'Checkout and fees', label: 'Small order fee', hint: 'Fee below the small order threshold', kind: 'money', units: '₹', effect: 'Checkout' },
  { key: 'surgeFeePaise', group: 'Checkout and fees', label: 'Surge fee', hint: 'Extra fee applied only while surge pricing is enabled', kind: 'money', units: '₹', effect: 'Checkout' },
  { key: 'catalogMaxPerOrder', group: 'Checkout and fees', label: 'Maximum quantity per product', hint: 'Maximum units of one product in a cart', kind: 'integer', units: 'units', effect: 'Cart' },
  { key: 'maxCartLines', group: 'Checkout and fees', label: 'Maximum different cart items', hint: 'Maximum number of products in a cart', kind: 'integer', units: 'items', effect: 'Cart' },
  { key: 'codEligibility', group: 'Checkout and fees', label: 'COD eligibility: completed prepaid orders', hint: 'Customers need this many completed orders before cash on delivery', kind: 'codEligibility', units: 'orders', effect: 'Checkout' },
  { key: 'refundDestinationPolicy', group: 'Checkout and fees', label: 'Refund destination', hint: 'Where refunds go after cancellation', kind: 'enum', effect: 'Payments', options: ['original', 'original_then_wallet', 'wallet'] },
  { key: 'promoSpendCapBps', group: 'Checkout and fees', label: 'Promo spend cap', hint: 'Maximum share of an order payable with promo credit', kind: 'integer', units: 'bps', effect: 'Checkout' },
  // ── Catalog and store operations ──
  { key: 'catalogAllowedGstBps', group: 'Catalog and store operations', label: 'Allowed GST rates', hint: 'Comma-separated tax rates in basis points', kind: 'numberList', units: 'bps', effect: 'Catalog' },
  { key: 'catalogPriceApprovalCount', group: 'Catalog and store operations', label: 'Price changes needing approval', hint: 'Changes beyond this count need approval', kind: 'integer', effect: 'Catalog' },
  { key: 'catalogPriceApprovalPercent', group: 'Catalog and store operations', label: 'Price change percentage', hint: 'Percent per change that triggers review', kind: 'integer', units: '%', effect: 'Catalog' },
  { key: 'catalogImportMaxBytes', group: 'Catalog and store operations', label: 'Import file size limit', hint: 'Maximum bytes per import file', kind: 'integer', units: 'bytes', effect: 'Catalog import' },
  { key: 'catalogImportMaxRows', group: 'Catalog and store operations', label: 'Import row limit', hint: 'Maximum rows per import file', kind: 'integer', units: 'rows', effect: 'Catalog import' },
  { key: 'catalogImportBatchSize', group: 'Catalog and store operations', label: 'Import batch size', hint: 'Rows processed per batch', kind: 'integer', units: 'rows', effect: 'Catalog import' },
  { key: 'catalogSuggestCacheSeconds', group: 'Catalog and store operations', label: 'Search suggestion cache', hint: 'Seconds suggestions are cached', kind: 'integer', units: 'seconds', effect: 'Catalog' },
  { key: 'inventoryAdjustmentApprovalUnits', group: 'Catalog and store operations', label: 'Stock adjustments needing approval', hint: 'Adjustments above this many units need approval', kind: 'integer', units: 'units', effect: 'Inventory' },
  { key: 'pickingSlaMinutes', group: 'Catalog and store operations', label: 'Picking SLA', hint: 'Minutes to pick an order', kind: 'integer', units: 'minutes', effect: 'Warehouse' },
  { key: 'maxActivePickTasksPerPicker', group: 'Catalog and store operations', label: 'Active pick tasks per picker', hint: 'Parallel picks per picker', kind: 'integer', effect: 'Warehouse' },
  { key: 'handoverMaxAttempts', group: 'Catalog and store operations', label: 'Handover attempts', hint: 'Maximum handover attempts with a delivery partner', kind: 'integer', effect: 'Fulfilment' },
  { key: 'handoverLockoutSeconds', group: 'Catalog and store operations', label: 'Handover lockout', hint: 'Seconds before another attempt is allowed', kind: 'integer', units: 'seconds', effect: 'Fulfilment' },
  { key: 'catalogLowStockThreshold', group: 'Catalog and store operations', label: 'Low-stock alert', hint: 'Available units at which stock is considered low', kind: 'integer', units: 'units', effect: 'Inventory' },
  { key: 'inventoryExpirySoonDays', group: 'Catalog and store operations', label: 'Expiry warning', hint: 'Days before a product expires', kind: 'integer', units: 'days', effect: 'Inventory' },
  { key: 'storeBacklogPauseThreshold', group: 'Catalog and store operations', label: 'Backlog pause threshold', hint: 'Pending orders that pause new orders for a store', kind: 'integer', effect: 'Store' },
  { key: 'storeNoRidersPauseMinutes', group: 'Catalog and store operations', label: 'No-rider pause after', hint: 'Minutes without a rider before pausing a store', kind: 'integer', units: 'minutes', effect: 'Store' },
  { key: 'maxPauseLengthDays', group: 'Catalog and store operations', label: 'Maximum store pause', hint: 'Longest pause a store can take', kind: 'integer', units: 'days', effect: 'Store' },
  // ── Dispatch and rider policies ──
  { key: 'requiredRiderDocuments', group: 'Dispatch and rider policies', label: 'Required rider documents', hint: 'Comma-separated document types', kind: 'stringList', effect: 'Onboarding' },
  { key: 'dispatchTrigger', group: 'Dispatch and rider policies', label: 'Dispatch trigger', hint: 'When delivery offers start', kind: 'enum', effect: 'Dispatch', options: ['ON_PICK_START', 'ON_PACKED'] },
  { key: 'dispatchRadiusM', group: 'Dispatch and rider policies', label: 'Initial dispatch radius', hint: 'Search radius in metres', kind: 'integer', units: 'm', effect: 'Dispatch' },
  { key: 'dispatchRadiusWideningStepsM', group: 'Dispatch and rider policies', label: 'Radius widening steps', hint: 'Comma-separated widening steps in metres', kind: 'numberList', units: 'm', effect: 'Dispatch' },
  { key: 'dispatchMaxAttempts', group: 'Dispatch and rider policies', label: 'Dispatch attempts', hint: 'Maximum offers before alerting', kind: 'integer', effect: 'Dispatch' },
  { key: 'dispatchAutoCancelMinutes', group: 'Dispatch and rider policies', label: 'Auto-cancel after', hint: 'Minutes before an undelivered dispatch cancels', kind: 'integer', units: 'minutes', effect: 'Dispatch' },
  { key: 'dispatchNoRiderAlertAfterAttempts', group: 'Dispatch and rider policies', label: 'No-rider alert after attempts', hint: 'Failed offers before alerting operations', kind: 'integer', effect: 'Dispatch' },
  { key: 'offerTimeoutSeconds', group: 'Dispatch and rider policies', label: 'Offer response time', hint: 'Seconds to accept a delivery offer', kind: 'integer', units: 'seconds', effect: 'Dispatch' },
  { key: 'offerDeclineCooldownSeconds', group: 'Dispatch and rider policies', label: 'Decline cooldown', hint: 'Seconds before a rider sees the order again', kind: 'integer', units: 'seconds', effect: 'Dispatch' },
  { key: 'riderMaxConcurrentTasks', group: 'Dispatch and rider policies', label: 'Maximum active deliveries', hint: 'Maximum assignments per delivery partner', kind: 'integer', effect: 'Rider app' },
  { key: 'riderStaleLocationSeconds', group: 'Dispatch and rider policies', label: 'Stale location after', hint: 'Seconds before a location is stale', kind: 'integer', units: 'seconds', effect: 'Dispatch' },
  { key: 'riderHeartbeatStaleSeconds', group: 'Dispatch and rider policies', label: 'Stale heartbeat after', hint: 'Seconds before a heartbeat is stale', kind: 'integer', units: 'seconds', effect: 'Dispatch' },
  { key: 'riderRedispatchMinutes', group: 'Dispatch and rider policies', label: 'Redispatch after', hint: 'Minutes before a stale dispatch is redone', kind: 'integer', units: 'minutes', effect: 'Dispatch' },
  { key: 'riderInactivityOfflineMinutes', group: 'Dispatch and rider policies', label: 'Inactivity before offline', hint: 'Minutes idle before going offline', kind: 'integer', units: 'minutes', effect: 'Rider app' },
  { key: 'riderMaxContinuousHours', group: 'Dispatch and rider policies', label: 'Maximum continuous hours', hint: 'Hours before a rider must rest', kind: 'number', units: 'hours', effect: 'Rider app' },
  { key: 'geofenceThresholdMetres', group: 'Dispatch and rider policies', label: 'Delivery geofence', hint: 'Metres from the address that count as arrived', kind: 'integer', units: 'm', effect: 'Delivery' },
  { key: 'deliveryCodeMaxAttempts', group: 'Dispatch and rider policies', label: 'Delivery code attempts', hint: 'Wrong codes allowed before lockout', kind: 'integer', effect: 'Delivery' },
  { key: 'deliveryCodeLockoutSeconds', group: 'Dispatch and rider policies', label: 'Delivery code lockout', hint: 'Seconds a delivery code locks after too many tries', kind: 'integer', units: 'seconds', effect: 'Delivery' },
  { key: 'deliveryFailureWaitSeconds', group: 'Dispatch and rider policies', label: 'Unavailable customer wait', hint: 'Required waiting time in seconds', kind: 'integer', units: 'seconds', effect: 'Delivery' },
  { key: 'deliveryFailureMinContactAttempts', group: 'Dispatch and rider policies', label: 'Minimum contact attempts', hint: 'Attempts before recording customer unavailable', kind: 'integer', effect: 'Delivery' },
  { key: 'cashInHandLimitPaise', group: 'Dispatch and rider policies', label: 'Cash-in-hand limit', hint: 'New cash assignments are restricted at the limit', kind: 'money', units: '₹', effect: 'Payments' },
  { key: 'earningsBasePaise', group: 'Dispatch and rider policies', label: 'Base delivery pay', hint: 'Base earning for a completed delivery', kind: 'money', units: '₹', effect: 'Payouts' },
  { key: 'earningsPerKmPaise', group: 'Dispatch and rider policies', label: 'Distance pay per kilometre', hint: 'Additional distance earning', kind: 'money', units: '₹', effect: 'Payouts' },
  { key: 'detentionFreeMinutes', group: 'Dispatch and rider policies', label: 'Free waiting time', hint: 'Minutes before waiting pay starts', kind: 'integer', units: 'minutes', effect: 'Payouts' },
  { key: 'detentionPerMinutePaise', group: 'Dispatch and rider policies', label: 'Waiting pay per minute', hint: 'Pay for eligible extra waiting', kind: 'money', units: '₹', effect: 'Payouts' },
  { key: 'termsVersion', group: 'Dispatch and rider policies', label: 'Terms version', hint: 'Current customer terms version', kind: 'text', effect: 'Legal' },
  { key: 'privacyVersion', group: 'Dispatch and rider policies', label: 'Privacy version', hint: 'Current customer privacy version', kind: 'text', effect: 'Legal' },
  // ── Support and communications ──
  { key: 'supportTicketCreationLimitPerHour', group: 'Support and communications', label: 'Support tickets per hour', hint: 'Maximum tickets one customer can open per hour', kind: 'integer', effect: 'Support' },
  { key: 'supportMessageMaxLength', group: 'Support and communications', label: 'Support message length', hint: 'Maximum characters per message', kind: 'integer', effect: 'Support' },
  { key: 'ratingAggregateMinimumCount', group: 'Support and communications', label: 'Minimum ratings to publish', hint: 'Ratings needed before an average is shown', kind: 'integer', effect: 'Ratings' },
  { key: 'lowRatingThreshold', group: 'Support and communications', label: 'Low rating threshold', hint: 'Stars at or below this trigger review', kind: 'integer', units: 'stars', effect: 'Ratings' },
  { key: 'supportDirectRefundLimitPaise', group: 'Support and communications', label: 'Direct refund limit', hint: 'Per-request refund agents can issue directly', kind: 'money', units: '₹', effect: 'Support' },
  { key: 'supportDailyRefundLimitPaise', group: 'Support and communications', label: 'Daily refund limit', hint: 'Per-agent direct refund total per day', kind: 'money', units: '₹', effect: 'Support' },
  { key: 'supportReopenDays', group: 'Support and communications', label: 'Reopen support requests', hint: 'Days after closing a request', kind: 'integer', units: 'days', effect: 'Support' },
  { key: 'reportExportMaxRows', group: 'Support and communications', label: 'Report export rows', hint: 'Maximum rows in one report export', kind: 'integer', units: 'rows', effect: 'Reports' },
  { key: 'reportExportMaxBytes', group: 'Support and communications', label: 'Report export size', hint: 'Maximum bytes in one report export', kind: 'integer', units: 'bytes', effect: 'Reports' },
  { key: 'reportExportTimeoutSeconds', group: 'Support and communications', label: 'Report export timeout', hint: 'Seconds before an export times out', kind: 'integer', units: 'seconds', effect: 'Reports' },
  { key: 'reportExportRetentionDays', group: 'Support and communications', label: 'Report retention', hint: 'Days generated reports are kept', kind: 'integer', units: 'days', effect: 'Reports' },
  { key: 'reportDownloadTtlSeconds', group: 'Support and communications', label: 'Report download link lifetime', hint: 'Seconds a download link stays valid', kind: 'integer', units: 'seconds', effect: 'Reports' },
  { key: 'notificationRetentionDays', group: 'Support and communications', label: 'Notification retention', hint: 'Days notifications are kept', kind: 'integer', units: 'days', effect: 'Notifications' },
  { key: 'notificationQuietHoursStart', group: 'Support and communications', label: 'Quiet hours start', hint: 'India time; promotional notifications wait until quiet hours end', kind: 'time', effect: 'Notifications' },
  { key: 'notificationQuietHoursEnd', group: 'Support and communications', label: 'Quiet hours end', hint: 'India time', kind: 'time', effect: 'Notifications' },
  { key: 'agent_proactive_nudges_enabled', group: 'Support and communications', label: 'Reorder reminders', hint: 'Reminders are sent only to customers who opt in', kind: 'boolean', effect: 'Assistant' },
  { key: 'agent_nudge_max_per_week', group: 'Support and communications', label: 'Maximum reminders per week', hint: 'Limit per opted-in customer', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_max_tool_calls_per_turn', group: 'Support and communications', label: 'Assistant tool calls per turn', hint: 'Maximum tool calls in one assistant turn', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_max_steps_per_run', group: 'Support and communications', label: 'Assistant steps per run', hint: 'Maximum steps in one assistant run', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_daily_turn_limit_per_user', group: 'Support and communications', label: 'Assistant messages per day', hint: 'Maximum per customer', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_daily_token_budget_per_user', group: 'Support and communications', label: 'Assistant token budget per day', hint: 'Maximum tokens per customer per day', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_max_order_value_paise', group: 'Support and communications', label: 'Assistant order value cap', hint: 'Largest order the assistant may place', kind: 'money', units: '₹', effect: 'Assistant' },
  { key: 'agent_max_qty_per_line', group: 'Support and communications', label: 'Assistant quantity cap', hint: 'Maximum quantity per line the assistant may order', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_history_max_tokens', group: 'Support and communications', label: 'Assistant history size', hint: 'Maximum tokens of history kept per thread', kind: 'integer', effect: 'Assistant' },
  { key: 'agent_thread_retention_days', group: 'Support and communications', label: 'Assistant thread retention', hint: 'Days assistant threads are kept', kind: 'integer', units: 'days', effect: 'Assistant' },
  { key: 'agent_confirm_ttl_seconds', group: 'Support and communications', label: 'Assistant confirmation lifetime', hint: 'Seconds an order confirmation stays valid', kind: 'integer', units: 'seconds', effect: 'Assistant' },
  // ── Referrals ──
  { key: 'referralIssuanceEnabled', group: 'Referrals', label: 'Referral issuance', hint: 'Allow new referral invites and claims (recorded claims still replay)', kind: 'boolean', effect: 'Referrals' },
  { key: 'referralRewardPaise', group: 'Referrals', label: 'Referral reward', hint: 'Promo credit granted per verified referral', kind: 'money', units: '₹', effect: 'Referrals' },
  { key: 'referralCreditExpiryMonths', group: 'Referrals', label: 'Referral credit expiry', hint: 'Calendar months the reward stays valid, India time', kind: 'integer', units: 'months', effect: 'Referrals' },
]

interface Pair {
  items: [Setting, Setting]
  kind: Kind
  validate: (a: string | number, b: string | number) => string | null
}

const pairs: Pair[] = [
  {
    items: [
      { key: 'minOrderPaise', group: 'Checkout and fees', label: 'Minimum order', hint: 'Smallest permitted order value', kind: 'money' },
      { key: 'maxOrderPaise', group: 'Checkout and fees', label: 'Maximum order', hint: 'Largest permitted order value', kind: 'money' },
    ],
    kind: 'money',
    validate: (a, b) => (typeof a === 'string' && typeof b === 'string' && BigInt(a) > BigInt(b) ? 'The minimum cannot be greater than the maximum order.' : null),
  },
  {
    items: [
      { key: 'paymentWindowSeconds', group: 'Checkout and fees', label: 'Payment window', hint: 'Seconds to complete an online payment; must not outlive the reservation TTL', kind: 'integer' },
      { key: 'inventoryReservationTtlSeconds', group: 'Checkout and fees', label: 'Reservation TTL', hint: 'Seconds stock stays reserved after checkout', kind: 'integer' },
    ],
    kind: 'integer',
    validate: (a, b) => (typeof a === 'number' && typeof b === 'number' && a > b ? 'The payment window must not outlive the reservation TTL.' : null),
  },
  {
    items: [
      { key: 'etaMinMinutes', group: 'Dispatch and rider policies', label: 'Minimum ETA', hint: 'Shortest promised delivery window', kind: 'integer' },
      { key: 'etaMaxMinutes', group: 'Dispatch and rider policies', label: 'Maximum ETA', hint: 'Longest promised delivery window', kind: 'integer' },
    ],
    kind: 'integer',
    validate: (a, b) => (typeof a === 'number' && typeof b === 'number' && a > b ? 'The minimum ETA cannot exceed the maximum ETA.' : null),
  },
  {
    items: [
      { key: 'zoneMinAreaM2', group: 'Dispatch and rider policies', label: 'Minimum zone area', hint: 'Smallest delivery zone area in square metres', kind: 'number' },
      { key: 'zoneMaxAreaM2', group: 'Dispatch and rider policies', label: 'Maximum zone area', hint: 'Largest delivery zone area in square metres', kind: 'number' },
    ],
    kind: 'number',
    validate: (a, b) => (typeof a === 'number' && typeof b === 'number' && a > b ? 'The minimum zone area cannot exceed the maximum zone area.' : null),
  },
  {
    items: [
      { key: 'supportFirstResponseSlaHours', group: 'Support and communications', label: 'First support response target', hint: 'Hours after a request is submitted', kind: 'integer' },
      { key: 'supportResolutionSlaHours', group: 'Support and communications', label: 'Support resolution target', hint: 'Hours to resolve a request', kind: 'integer' },
    ],
    kind: 'integer',
    validate: (a, b) => (typeof a === 'number' && typeof b === 'number' && a > b ? 'The first response target cannot be later than the resolution target.' : null),
  },
  {
    items: [
      { key: 'ratingEditHours', group: 'Support and communications', label: 'Rating edit window', hint: 'Hours a rating can be edited; must not exceed the rating window', kind: 'integer' },
      { key: 'ratingWindowHours', group: 'Support and communications', label: 'Rating window', hint: 'Hours a rating can be given at all', kind: 'integer' },
    ],
    kind: 'integer',
    validate: (a, b) => (typeof a === 'number' && typeof b === 'number' && a > b ? 'The edit window cannot exceed the rating window.' : null),
  },
]

const groupTitles = ['Checkout and fees', 'Catalog and store operations', 'Dispatch and rider policies', 'Support and communications', 'Referrals']

function display(value: unknown, kind: Kind): string {
  if (kind === 'money' && typeof value === 'string' && /^\d+$/.test(value)) {
    const n = BigInt(value)
    return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`
  }
  if (kind === 'time' && typeof value === 'number') return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  if (kind === 'stringList' && Array.isArray(value)) return value.join(', ')
  if (kind === 'numberList' && Array.isArray(value)) return value.join(', ')
  if (kind === 'codEligibility' && typeof value === 'object' && value !== null) return String((value as { minCompletedPrepaidOrders?: unknown }).minCompletedPrepaidOrders ?? '')
  return String(value ?? '')
}

function parse(value: string, kind: Kind): string | number | string[] | number[] {
  if (kind === 'money') {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter a valid amount with up to two decimal places.')
    const [whole, fraction = ''] = value.split('.')
    const paise = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
    if (paise > 9223372036854775807n) throw new Error('This amount is too large.')
    return paise.toString()
  }
  if (kind === 'time') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Enter a valid time.')
    const [hours, minutes] = value.split(':').map(Number)
    return hours! * 60 + minutes!
  }
  if (kind === 'stringList') {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean)
    if (!items.length || items.length > 32) throw new Error('Enter between 1 and 32 document types.')
    return items
  }
  if (kind === 'numberList') {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean)
    if (!items.length) throw new Error('Enter at least one value.')
    return items.map((item) => {
      if (!/^\d+$/.test(item) || !Number.isSafeInteger(Number(item))) throw new Error('Enter whole numbers only.')
      return Number(item)
    })
  }
  if (kind === 'number') {
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error('Enter a valid number.')
    return Number(value)
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Enter a whole number.')
  return Number(value)
}

const integerRanges: Record<string, [number, number]> = {
  catalogMaxPerOrder: [1, Number.MAX_SAFE_INTEGER], maxCartLines: [1, Number.MAX_SAFE_INTEGER],
  offerTimeoutSeconds: [1, 3600], riderMaxConcurrentTasks: [1, 20], detentionFreeMinutes: [0, 1440],
  deliveryFailureWaitSeconds: [0, 86400], deliveryFailureMinContactAttempts: [1, 20],
  agent_nudge_max_per_week: [0, 7], agent_daily_turn_limit_per_user: [1, 10000],
  catalogLowStockThreshold: [1, Number.MAX_SAFE_INTEGER], inventoryExpirySoonDays: [1, Number.MAX_SAFE_INTEGER],
  supportFirstResponseSlaHours: [1, 720], supportResolutionSlaHours: [1, 2160], supportReopenDays: [0, 90],
  paymentWindowSeconds: [1, 86400], inventoryReservationTtlSeconds: [1, 86400],
  promoSpendCapBps: [0, 10000], codEligibility: [0, 1000],
  catalogPriceApprovalCount: [1, Number.MAX_SAFE_INTEGER], catalogPriceApprovalPercent: [0, 10000],
  catalogImportMaxBytes: [1, Number.MAX_SAFE_INTEGER], catalogImportMaxRows: [1, Number.MAX_SAFE_INTEGER],
  catalogImportBatchSize: [1, 1000], catalogSuggestCacheSeconds: [1, 3600],
  inventoryAdjustmentApprovalUnits: [1, Number.MAX_SAFE_INTEGER], pickingSlaMinutes: [1, 1440],
  maxActivePickTasksPerPicker: [1, 50], handoverMaxAttempts: [1, 20], handoverLockoutSeconds: [0, 86400],
  storeBacklogPauseThreshold: [1, Number.MAX_SAFE_INTEGER], storeNoRiderPauseMinutes: [1, Number.MAX_SAFE_INTEGER],
  maxPauseLengthDays: [1, Number.MAX_SAFE_INTEGER],
  dispatchRadiusM: [1, 100000], dispatchMaxAttempts: [1, 100], dispatchAutoCancelMinutes: [1, 1440],
  dispatchNoRiderAlertAfterAttempts: [1, 100], offerDeclineCooldownSeconds: [0, 86400],
  riderStaleLocationSeconds: [1, 3600], riderHeartbeatStaleSeconds: [1, 3600],
  riderRedispatchMinutes: [1, 1440], riderInactivityOfflineMinutes: [1, 1440],
  geofenceThresholdMetres: [1, 10000], deliveryCodeMaxAttempts: [1, 20], deliveryCodeLockoutSeconds: [1, 86400],
  etaMinMinutes: [0, Number.MAX_SAFE_INTEGER], etaMaxMinutes: [0, Number.MAX_SAFE_INTEGER],
  supportTicketCreationLimitPerHour: [1, 1000], supportMessageMaxLength: [1, 10000],
  ratingAggregateMinimumCount: [1, 10000], lowRatingThreshold: [1, 5],
  ratingWindowHours: [1, 2160], ratingEditHours: [0, 2160],
  reportExportMaxRows: [1, 1000000], reportExportMaxBytes: [1048576, 536870912],
  reportExportTimeoutSeconds: [10, 900], reportExportRetentionDays: [1, 90],
  reportDownloadTtlSeconds: [30, 300], notificationRetentionDays: [1, 3650],
  agent_max_tool_calls_per_turn: [1, 100], agent_max_steps_per_run: [1, 200],
  agent_daily_token_budget_per_user: [1, 10000000], agent_max_qty_per_line: [1, 1000],
  agent_history_max_tokens: [256, 100000], agent_thread_retention_days: [1, 365],
  agent_confirm_ttl_seconds: [30, 86400], referralCreditExpiryMonths: [1, 12],
}

function isConflict(cause: unknown): boolean {
  return cause instanceof Error && (cause as { code?: string }).code === 'CONCURRENT_MODIFICATION'
}

function ConflictOffer({ conflicted, onRefresh }: { conflicted: boolean; onRefresh: () => void }) {
  if (!conflicted) return null
  return (
    <p role="alert" className="flex items-center gap-2 text-xs font-semibold text-destructive">
      Another admin changed this setting.
      <Button size="sm" variant="outline" onClick={onRefresh}>Refresh</Button>
    </p>
  )
}

function SettingRow({ setting, value, revisions }: { setting: Setting; value: unknown; revisions: Record<string, string> }) {
  const client = useQueryClient()
  const refresh = () => void client.invalidateQueries({ queryKey: ['config'] })
  const [raw, setRaw] = useState(() => display(value, setting.kind))
  const [enabled, setEnabled] = useState(value === true)
  const [enumValue, setEnumValue] = useState(() => (typeof value === 'string' ? value : ''))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setRaw(display(value, setting.kind))
    setEnabled(value === true)
    setEnumValue(typeof value === 'string' ? value : '')
  }, [value, setting.kind])
  const mutation = useMutation({
    mutationFn: (next: unknown) => updateConfigKey(setting.key, next, revisions[setting.key]),
    onSuccess: async () => { await refresh(); setError(''); setSaved(true) },
    onError: (cause) => setError(isConflict(cause) ? '' : cause instanceof Error ? cause.message : 'Could not save this setting.'),
  })
  const save = () => {
    try {
      setError(''); setSaved(false)
      let next: unknown
      if (setting.kind === 'boolean') next = enabled
      else if (setting.kind === 'enum') next = enumValue
      else if (setting.kind === 'codEligibility') {
        const count = parse(raw, 'integer')
        const range = integerRanges.codEligibility!
        if (typeof count === 'number' && (count < range[0] || count > range[1])) throw new Error(`Enter a whole number between ${range[0]} and ${range[1]}.`)
        next = { minCompletedPrepaidOrders: count }
      } else {
        next = parse(raw, setting.kind)
        const range = integerRanges[setting.key]
        if (range && typeof next === 'number' && (next < range[0] || next > range[1])) throw new Error(`Enter a whole number between ${range[0]} and ${range[1]}.`)
      }
      mutation.mutate(next)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check this value.') }
  }
  const disabled = mutation.isPending || value === undefined
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-border/60 py-3 first:border-0">
      <div className="min-w-56 flex-1">
        <p className="text-sm font-semibold">{setting.label}</p>
        <p className="text-xs text-muted-foreground">{setting.hint}</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <ConflictOffer conflicted={isConflict(mutation.error)} onRefresh={refresh} />
        {saved && <p role="status" className="text-xs text-brand-700">Saved</p>}
      </div>
      {setting.kind === 'boolean' ? (
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
      ) : setting.kind === 'enum' ? (
        <label className="flex items-center gap-1 text-sm">
          <Select value={enumValue} onValueChange={setEnumValue} options={(setting.options ?? []).map((option) => ({ value: option, label: option }))} />
        </label>
      ) : (
        <label className="flex items-center gap-1 text-sm">
          {setting.kind === 'money' && '₹'}
          {setting.kind === 'codEligibility' && <span className="text-xs text-muted-foreground">orders</span>}
          <Input type={setting.kind === 'time' ? 'time' : 'text'} inputMode={setting.kind === 'money' ? 'decimal' : 'numeric'} aria-label={setting.label} className="w-32" value={raw} disabled={disabled} onChange={(e) => { setSaved(false); setRaw(e.target.value) }} />
        </label>
      )}
      <Button size="sm" variant="outline" disabled={disabled} onClick={save}>{mutation.isPending ? 'Saving…' : 'Save'}</Button>
    </div>
  )
}

function PairRow({ pair, config, revisions }: { pair: Pair; config: Record<string, unknown>; revisions: Record<string, string> }) {
  const client = useQueryClient()
  const refresh = () => void client.invalidateQueries({ queryKey: ['config'] })
  const [first, setFirst] = useState(() => display(config[pair.items[0].key], pair.kind))
  const [second, setSecond] = useState(() => display(config[pair.items[1].key], pair.kind))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => { setFirst(display(config[pair.items[0].key], pair.kind)) }, [config[pair.items[0].key], pair.kind])
  useEffect(() => { setSecond(display(config[pair.items[1].key], pair.kind)) }, [config[pair.items[1].key], pair.kind])
  const mutation = useMutation({
    mutationFn: (changes: Array<{ key: string; value: unknown; expectedVersion?: string }>) => batchUpdateConfig(changes),
    onSuccess: async () => { await refresh(); setError(''); setSaved(true) },
    onError: (cause) => setError(isConflict(cause) ? '' : cause instanceof Error ? cause.message : 'Could not save these settings.'),
  })
  const missing = config[pair.items[0].key] === undefined || config[pair.items[1].key] === undefined
  const save = () => {
    try {
      setError(''); setSaved(false)
      const a = parse(first, pair.kind)
      const b = parse(second, pair.kind)
      for (const [rawValue, item] of [[a, pair.items[0]], [b, pair.items[1]]] as const) {
        const range = integerRanges[item.key]
        if (range && typeof rawValue === 'number' && (rawValue < range[0] || rawValue > range[1])) throw new Error(`Enter a whole number between ${range[0]} and ${range[1]}.`)
      }
      const message = pair.validate(a as string | number, b as string | number)
      if (message) throw new Error(message)
      mutation.mutate([
        { key: pair.items[0].key, value: a, expectedVersion: revisions[pair.items[0].key] },
        { key: pair.items[1].key, value: b, expectedVersion: revisions[pair.items[1].key] },
      ])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check these values.') }
  }
  const disabled = mutation.isPending || missing
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-border/60 py-3 first:border-0">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-semibold">{pair.items[0].label} / {pair.items[1].label}</p>
        <p className="text-xs text-muted-foreground">{pair.items[0].hint}</p>
        <p className="text-xs text-muted-foreground">{pair.items[1].hint}</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <ConflictOffer conflicted={isConflict(mutation.error)} onRefresh={refresh} />
        {saved && <p role="status" className="text-xs text-brand-700">Saved</p>}
      </div>
      <label className="flex items-center gap-1 text-sm">
        {pair.kind === 'money' && '₹'}
        <Input type="text" inputMode={pair.kind === 'money' ? 'decimal' : 'numeric'} aria-label={pair.items[0].label} className="w-28" value={first} disabled={disabled} onChange={(e) => { setSaved(false); setFirst(e.target.value) }} />
      </label>
      <label className="flex items-center gap-1 text-sm">
        {pair.kind === 'money' && '₹'}
        <Input type="text" inputMode={pair.kind === 'money' ? 'decimal' : 'numeric'} aria-label={pair.items[1].label} className="w-28" value={second} disabled={disabled} onChange={(e) => { setSaved(false); setSecond(e.target.value) }} />
      </label>
      <Button size="sm" variant="outline" disabled={disabled} onClick={save}>{mutation.isPending ? 'Saving…' : 'Save'}</Button>
    </div>
  )
}

type Slab = { maxOrderValuePaise: string | null; feePaise: string }
function FeeSlabs({ value, revisions }: { value: unknown; revisions: Record<string, string> }) {
  const client = useQueryClient()
  const refresh = () => void client.invalidateQueries({ queryKey: ['config'] })
  const [rows, setRows] = useState<Array<{ ceiling: string; fee: string }>>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (Array.isArray(value)) setRows((value as Slab[]).map(row => ({ ceiling: row.maxOrderValuePaise === null ? '' : display(row.maxOrderValuePaise, 'money'), fee: display(row.feePaise, 'money') }))) }, [value])
  const mutation = useMutation({ mutationFn: (next: Slab[]) => updateConfigKey('deliveryFeeSlabs', next, revisions.deliveryFeeSlabs), onSuccess: async () => { await refresh(); setError(''); setSaved(true) }, onError: (cause) => setError(isConflict(cause) ? '' : cause instanceof Error ? cause.message : 'Could not save delivery fees.') })
  const change = (index: number, field: 'ceiling' | 'fee', text: string) => { setSaved(false); setRows(current => current.map((row, i) => i === index ? { ...row, [field]: text } : row)) }
  const save = () => { try { if (!rows.length || rows.length > 20) throw new Error('Add between 1 and 20 fee ranges.'); let previous = -1n; const next = rows.map((row, i) => { const ceiling = row.ceiling.trim() ? String(parse(row.ceiling, 'money')) : null; if (ceiling === null && i !== rows.length - 1) throw new Error('Only the last range can be open-ended.'); if (ceiling !== null && BigInt(ceiling) <= previous) throw new Error('Order limits must increase in each range.'); if (ceiling !== null) previous = BigInt(ceiling); return { maxOrderValuePaise: ceiling, feePaise: String(parse(row.fee, 'money')) } }); setError(''); setSaved(false); mutation.mutate(next) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the fee ranges.') } }
  const disabled = mutation.isPending || value === undefined
  return <Card className="space-y-3 p-5"><h3 className="font-semibold">Delivery fee ranges</h3><p className="text-xs text-muted-foreground">Set each order-value limit and its delivery fee. Leave the final limit empty for all larger orders.</p>{rows.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-2 text-sm"><span>Up to ₹</span><Input className="w-28" value={row.ceiling} onChange={e => change(index, 'ceiling', e.target.value)} aria-label={`Order limit ${index + 1}`} placeholder="No limit" disabled={disabled} /><span>Fee ₹</span><Input className="w-28" value={row.fee} onChange={e => change(index, 'fee', e.target.value)} aria-label={`Delivery fee ${index + 1}`} disabled={disabled} /><Button variant="outline" size="sm" disabled={rows.length <= 1 || disabled} onClick={() => setRows(current => current.filter((_, i) => i !== index))}>Remove</Button></div>)}
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={rows.length >= 20 || disabled} onClick={() => setRows(current => [...current, { ceiling: '', fee: '0.00' }])}>Add range</Button><Button size="sm" disabled={disabled} onClick={save}>{mutation.isPending ? 'Saving…' : 'Save fees'}</Button></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<ConflictOffer conflicted={isConflict(mutation.error)} onRefresh={refresh} />{saved && <p role="status" className="text-xs text-brand-700">Saved</p>}</Card>
}

interface TaxRule { appliesTo: string; taxBps: string; split: string }
const TAX_KINDS = ['DELIVERY', 'HANDLING', 'SMALL_CART', 'SURGE', 'ALL']
const TAX_SPLITS = ['CGST_SGST', 'IGST']
function FeeTaxRules({ value, revisions }: { value: unknown; revisions: Record<string, string> }) {
  const client = useQueryClient()
  const refresh = () => void client.invalidateQueries({ queryKey: ['config'] })
  const [rows, setRows] = useState<TaxRule[]>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (Array.isArray(value)) setRows((value as Array<{ appliesTo: string; taxBps: number; split: string }>).map((row) => ({ appliesTo: row.appliesTo, taxBps: String(row.taxBps), split: row.split })))
  }, [value])
  const mutation = useMutation({
    mutationFn: (next: Array<{ appliesTo: string; taxBps: number; split: string }>) => updateConfigKey('feeTaxRules', next, revisions.feeTaxRules),
    onSuccess: async () => { await refresh(); setError(''); setSaved(true) },
    onError: (cause) => setError(isConflict(cause) ? '' : cause instanceof Error ? cause.message : 'Could not save fee tax rules.'),
  })
  const change = (index: number, field: keyof TaxRule, text: string) => { setSaved(false); setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: text } : row))) }
  const save = () => {
    try {
      if (rows.length > 20) throw new Error('Add at most 20 fee tax rules.')
      const next = rows.map((row) => {
        if (!TAX_KINDS.includes(row.appliesTo)) throw new Error('Choose a fee kind for every rule.')
        if (!TAX_SPLITS.includes(row.split)) throw new Error('Choose a tax split for every rule.')
        const taxBps = parse(row.taxBps, 'integer')
        if (typeof taxBps !== 'number' || taxBps < 0 || taxBps > 10000) throw new Error('Tax rate must be between 0 and 10000 basis points.')
        return { appliesTo: row.appliesTo, taxBps, split: row.split }
      })
      setError(''); setSaved(false); mutation.mutate(next)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the fee tax rules.') }
  }
  const disabled = mutation.isPending || !Array.isArray(value)
  return (
    <Card className="space-y-3 p-5">
      <h3 className="font-semibold">Fee tax rules</h3>
      <p className="text-xs text-muted-foreground">Tax per fee kind, in basis points (100 = 1%). Choose whether tax is split as CGST+SGST or charged as IGST.</p>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
          <Select value={row.appliesTo} onValueChange={(v) => change(index, 'appliesTo', v)} options={TAX_KINDS.map((kind) => ({ value: kind, label: kind }))} />
          <Input className="w-24" value={row.taxBps} onChange={(e) => change(index, 'taxBps', e.target.value)} aria-label={`Tax rate ${index + 1}`} placeholder="bps" disabled={disabled} />
          <span className="text-xs text-muted-foreground">bps</span>
          <Select value={row.split} onValueChange={(v) => change(index, 'split', v)} options={TAX_SPLITS.map((split) => ({ value: split, label: split }))} />
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>Remove</Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={rows.length >= 20 || disabled} onClick={() => setRows((current) => [...current, { appliesTo: 'DELIVERY', taxBps: '0', split: 'CGST_SGST' }])}>Add tax rule</Button>
        <Button size="sm" disabled={disabled} onClick={save}>{mutation.isPending ? 'Saving…' : 'Save tax rules'}</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <ConflictOffer conflicted={isConflict(mutation.error)} onRefresh={refresh} />
      {saved && <p role="status" className="text-xs text-brand-700">Saved</p>}
    </Card>
  )
}

export function OperationalSettings({ config, configRevisions }: { config: Record<string, unknown>; configRevisions?: Record<string, string> }) {
  const revisions = configRevisions ?? {}
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">These settings apply across the business. Store-specific hours and capacity are managed under Stores.</p>
      <FeeSlabs value={config.deliveryFeeSlabs} revisions={revisions} />
      <FeeTaxRules value={config.feeTaxRules} revisions={revisions} />
      {groupTitles.map((title) => {
        const items = settings.filter((setting) => setting.group === title)
        const pairItems = pairs.filter((pair) => pair.items[0].group === title)
        if (!items.length && !pairItems.length) return null
        return (
          <Card key={title} className="px-5 py-3">
            <h3 className="pb-2 font-semibold">{title}</h3>
            {pairItems.map((pair) => <PairRow key={pair.items[0].key} pair={pair} config={config} revisions={revisions} />)}
            {items.map((setting) => <SettingRow key={setting.key} setting={setting} value={config[setting.key]} revisions={revisions} />)}
          </Card>
        )
      })}
    </div>
  )
}

