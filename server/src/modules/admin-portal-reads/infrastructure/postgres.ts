import { sql, type RawBuilder } from 'kysely';
import { ConfigService } from '../../../config/config.service.js';
import type { Database } from '../../../platform/database/database.js';
import { MEDIA_STORAGE, type StoragePort } from '../../media/contracts/storage.js';
import { RIDER_ELIGIBILITY, type RiderEligibility } from '../../riders/contracts/riders.js';
import { Inject } from '@nestjs/common';
import {
  encodeKeysetCursor,
  type AdminDashboardView,
  type AdminPortalReads,
  type DashboardQuery,
  type FleetRiderView,
  type FleetView,
  type GlobalSearchGroup,
  type GlobalSearchView,
  type InventorySummaryFilter,
  type InventorySummaryItem,
  type InvoiceDownloadView,
  type LegalHoldListItem,
  type Page,
  type PaymentAttemptFilter,
  type PaymentAttemptListItem,
  type RatingListItem,
  type RatingsFilter,
  type RefundFilter,
  type RefundListItem,
  type RiderCandidateView,
} from '../contracts/admin-portal-reads.js';

const FLEET_LIMIT = 200;
export const FLEET_FRESHNESS_SECONDS = 120;
/** A store counts as low-stock while at most this many saleable units remain. */
export const LOW_STOCK_UNITS = 5;
const SEARCH_ITEMS_PER_GROUP = 5;
const MAX_DASHBOARD_DAYS = 92;
const CUSTODY_STATUSES = sql`('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')`;

const ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  'CREATED',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'UNKNOWN',
]);
const REFUND_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN']);
const PAYMENT_METHODS: ReadonlySet<string> = new Set(['GATEWAY', 'WALLET', 'COD', 'ZERO_DUE']);

interface Keyset {
  readonly c: string;
  readonly i: string;
}

function boundedLimit(limit: number | undefined, max = 100, fallback = 50): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new Error('INVALID_PAGE');
  return limit;
}

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw new Error('INVALID_DATE');
  return value;
}

function isoDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error('INVALID_DATE');
  return new Date(parsed).toISOString();
}

function keyset(raw: unknown): Keyset {
  const value = raw as Partial<Keyset> | null;
  if (typeof value?.c !== 'string' || typeof value?.i !== 'string')
    throw new Error('INVALID_CURSOR');
  return { c: isoDateTime(value.c), i: value.i };
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Set-based read models for the admin portal (P14). Money is integer paise
 * serialized as decimal strings; dashboard business-day bounds resolve in
 * Asia/Kolkata; every list is keyset-paginated or hard-bounded.
 */
export class PostgresAdminPortalReads implements AdminPortalReads {
  constructor(
    private readonly db: Database,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
    @Inject(RIDER_ELIGIBILITY) private readonly eligibility: RiderEligibility,
    private readonly config: ConfigService,
  ) {}

  async dashboard(query: DashboardQuery): Promise<AdminDashboardView> {
    const from = isoDate(query.from);
    const to = isoDate(query.to);
    const days = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
    );
    if (days < 0 || days > MAX_DASHBOARD_DAYS) throw new Error('INVALID_DATE_RANGE');
    const windowStart = sql`${from}::date AT TIME ZONE 'Asia/Kolkata'`;
    const windowEnd = sql`(${to}::date + 1) AT TIME ZONE 'Asia/Kolkata'`;
    const storeFilter = query.storeId ? sql` AND o.store_id=${query.storeId}::uuid` : sql``;
    const [invoices, refunds, topups, orderCounts, onHold, storeCounts, customerCounts] =
      await Promise.all([
        sql<{
          kind: string;
          total: string;
        }>`SELECT d.kind,COALESCE(SUM((d.payload->>'totalPaise')::numeric),0)::text AS total
          FROM invoice_documents d JOIN orders o ON o.id=d.order_id
          WHERE d.status='ISSUED' AND d.issued_at >= ${windowStart} AND d.issued_at < ${windowEnd}${storeFilter}
          GROUP BY d.kind`.execute(this.db),
        sql<{ total: string }>`SELECT COALESCE(SUM(r.amount_paise),0)::text AS total
          FROM payment_refunds r JOIN orders o ON o.id=r.order_id
          WHERE r.status='PROCESSED' AND r.updated_at >= ${windowStart} AND r.updated_at < ${windowEnd}${storeFilter}`.execute(
          this.db,
        ),
        query.storeId
          ? Promise.resolve({ rows: [] as { total: string }[] })
          : sql<{ total: string }>`SELECT COALESCE(SUM(a.amount_paise),0)::text AS total
              FROM payment_attempts a
              WHERE a.kind='WALLET_TOPUP' AND a.status='CAPTURED'
                AND COALESCE(a.captured_at,a.created_at) >= ${windowStart}
                AND COALESCE(a.captured_at,a.created_at) < ${windowEnd}`.execute(this.db),
        sql<{ status: string; count: string }>`SELECT o.status,COUNT(*)::text AS count FROM orders o
          WHERE o.placed_at >= ${windowStart} AND o.placed_at < ${windowEnd}${storeFilter}
          GROUP BY o.status`.execute(this.db),
        sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM orders o
          WHERE o.on_hold AND o.placed_at >= ${windowStart} AND o.placed_at < ${windowEnd}${storeFilter}`.execute(
          this.db,
        ),
        sql<{ total: string; online: string }>`SELECT COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE status='ONLINE')::text AS online FROM stores`.execute(this.db),
        sql<{ total: string; active: string }>`SELECT COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE status='ACTIVE')::text AS active FROM users WHERE pool='CUSTOMER'`.execute(
          this.db,
        ),
      ]);
    const invoiceTotal = invoices.rows.find((row) => row.kind === 'INVOICE')?.total ?? null;
    const creditNoteTotal = invoices.rows.find((row) => row.kind === 'CREDIT_NOTE')?.total ?? null;
    const statusKeys = {
      PENDING_PAYMENT: 'placed',
      CONFIRMED: 'confirmed',
      PICKING: 'picking',
      PACKED: 'packed',
      OUT_FOR_DELIVERY: 'outForDelivery',
      DELIVERED: 'delivered',
      CANCELLED: 'cancelled',
      EXPIRED: 'expired',
    } as const;
    const orders: { -readonly [K in keyof AdminDashboardView['orders']]: number } = {
      placed: 0,
      confirmed: 0,
      picking: 0,
      packed: 0,
      outForDelivery: 0,
      delivered: 0,
      cancelled: 0,
      expired: 0,
      onHold: Number(onHold.rows[0]?.count ?? 0),
    };
    for (const row of orderCounts.rows) {
      const key = statusKeys[row.status as keyof typeof statusKeys];
      if (key) orders[key] = Number(row.count);
    }
    return {
      period: { from, to },
      invoicedSalesPaise:
        invoiceTotal === null && creditNoteTotal === null
          ? null
          : (BigInt(invoiceTotal ?? '0') - BigInt(creditNoteTotal ?? '0')).toString(),
      creditNotesPaise: creditNoteTotal,
      refundsProcessedPaise: refunds.rows[0]?.total ?? '0',
      walletTopUpsPaise: { total: query.storeId ? null : (topups.rows[0]?.total ?? '0') },
      orders,
      stores: {
        total: Number(storeCounts.rows[0]?.total ?? 0),
        online: Number(storeCounts.rows[0]?.online ?? 0),
      },
      customers: {
        total: Number(customerCounts.rows[0]?.total ?? 0),
        active: Number(customerCounts.rows[0]?.active ?? 0),
      },
    };
  }

  async fleet(): Promise<FleetView> {
    // Single round trip: availability, presence and the latest location+speed
    // join into one statement (no per-rider location lookups).
    const rows = await sql<{
      rider_id: string;
      name: string;
      store_id: string | null;
      availability: 'AVAILABLE' | 'ON_DELIVERY' | 'OFFLINE' | 'UNKNOWN';
      last_location_at: Date | null;
      lat: number | null;
      lng: number | null;
    }>`SELECT u.id::text AS rider_id,u.name,p.home_store_id::text AS store_id,
        CASE
          WHEN s.rider_id IS NULL THEN 'UNKNOWN'
          WHEN EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.rider_id=u.id
            AND t.status IN ${CUSTODY_STATUSES}) THEN 'ON_DELIVERY'
          WHEN s.online AND NOT s.on_break AND p.status='APPROVED' AND u.status='ACTIVE' THEN 'AVAILABLE'
          ELSE 'OFFLINE'
        END AS availability,
        s.last_location_at,
        ST_Y(s.last_location::geometry) AS lat,
        ST_X(s.last_location::geometry) AS lng
      FROM users u
      JOIN user_roles r ON r.user_id=u.id AND r.role='RIDER'
      LEFT JOIN rider_profiles p ON p.user_id=u.id
      LEFT JOIN rider_status s ON s.rider_id=u.id
      ORDER BY u.name,u.id LIMIT ${FLEET_LIMIT}`.execute(this.db);
    const now = Date.now();
    const items: FleetRiderView[] = rows.rows.map((row) => {
      const hasLocation = row.lat !== null && row.lng !== null && row.last_location_at !== null;
      return {
        riderId: row.rider_id,
        name: row.name,
        storeId: row.store_id,
        availability: row.availability,
        lastLocation: hasLocation ? { lat: Number(row.lat), lng: Number(row.lng) } : null,
        lastUpdateAt: row.last_location_at?.toISOString() ?? null,
        fresh:
          hasLocation && now - row.last_location_at!.getTime() <= FLEET_FRESHNESS_SECONDS * 1000,
      };
    });
    return { items, freshnessSeconds: FLEET_FRESHNESS_SECONDS };
  }

  /** Same RIDER_ELIGIBILITY port dispatch revalidates offer candidates with. */
  async riderCandidates(orderId: string): Promise<readonly RiderCandidateView[]> {
    const order = await sql<{
      store_id: string;
      payment_method: string | null;
      amount_due_paise: string;
    }>`SELECT store_id::text AS store_id,payment_method,amount_due_paise::text AS amount_due_paise
      FROM orders WHERE id=${orderId}::uuid`.execute(this.db);
    const row = order.rows[0];
    if (!row) throw new Error('ORDER_NOT_FOUND');
    const riders = await sql<{
      rider_id: string;
      name: string;
    }>`SELECT u.id::text AS rider_id,u.name
      FROM rider_profiles p JOIN users u ON u.id=p.user_id AND u.status='ACTIVE'
      WHERE p.home_store_id=${row.store_id}::uuid
      ORDER BY u.name,u.id LIMIT 50`.execute(this.db);
    if (!riders.rows.length) return [];
    const results = await this.eligibility.eligibleForDispatch({
      riderIds: riders.rows.map((rider) => rider.rider_id),
      at: new Date(),
      codAmountPaise: row.payment_method === 'COD' ? row.amount_due_paise : undefined,
    });
    return riders.rows.map((rider) => {
      const outcome = results[rider.rider_id];
      return {
        riderId: rider.rider_id,
        name: rider.name,
        eligible: outcome?.eligible === true,
        reason: outcome?.eligible ? null : (outcome?.reason ?? 'NOT_APPROVED'),
      };
    });
  }

  async orderInvoice(orderId: string): Promise<InvoiceDownloadView> {
    const rows = await sql<{
      id: string;
      number: string;
      renderer_state: string;
    }>`SELECT id::text AS id,number,renderer_state
      FROM invoice_documents
      WHERE order_id=${orderId}::uuid AND kind='INVOICE' AND status='ISSUED'
      ORDER BY created_at DESC LIMIT 1`.execute(this.db);
    const document = rows.rows[0];
    if (!document) throw new Error('INVOICE_NOT_FOUND');
    if (document.renderer_state !== 'RENDERED') throw new Error('INVOICE_NOT_RENDERED');
    const expiresIn = this.config.get('PRIVATE_READ_URL_TTL_SECONDS');
    return {
      url: await this.storage.signedRead(`private/${document.id}`, expiresIn),
      expiresIn,
      documentId: document.id,
      number: document.number,
    };
  }

  async paymentAttempts(filter: PaymentAttemptFilter): Promise<Page<PaymentAttemptListItem>> {
    const limit = boundedLimit(filter.limit);
    if (filter.status && !ATTEMPT_STATUSES.has(filter.status)) throw new Error('INVALID_INPUT');
    if (filter.method && !PAYMENT_METHODS.has(filter.method)) throw new Error('INVALID_INPUT');
    const cursor = filter.cursor
      ? keyset(JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')))
      : null;
    const conditions: RawBuilder<unknown>[] = [
      filter.storeId ? sql`o.store_id=${filter.storeId}::uuid` : null,
      filter.status ? sql`a.status=${filter.status}` : null,
      filter.method ? sql`o.payment_method=${filter.method}` : null,
      filter.from ? sql`a.created_at >= ${isoDateTime(filter.from)}::timestamptz` : null,
      filter.to ? sql`a.created_at < ${isoDateTime(filter.to)}::timestamptz` : null,
      filter.search
        ? sql`(o.order_number ILIKE ${`%${escapeLike(filter.search)}%`} OR a.operation_reference ILIKE ${`%${escapeLike(filter.search)}%`} OR a.gateway_payment_id ILIKE ${`%${escapeLike(filter.search)}%`})`
        : null,
      cursor ? sql`(a.created_at,a.id::text) < (${cursor.c}::timestamptz,${cursor.i})` : null,
    ].filter((entry): entry is RawBuilder<unknown> => entry !== null);
    const rows =
      await sql<PaymentAttemptRow>`SELECT a.id::text AS attempt_id,a.order_id::text AS order_id,
      o.order_number,o.store_id::text AS store_id,s.name AS store_name,a.kind,a.gateway,
      a.gateway_payment_id,a.amount_paise::text AS amount_paise,a.status,a.failure_code,
      o.payment_method,a.created_at
      FROM payment_attempts a
      LEFT JOIN orders o ON o.id=a.order_id
      LEFT JOIN stores s ON s.id=o.store_id
      ${conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``}
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit + 1}`.execute(this.db);
    return keysetPage(
      rows.rows,
      limit,
      (row) => ({ c: row.created_at.toISOString(), i: row.attempt_id }),
      (row) => ({
        attemptId: row.attempt_id,
        orderId: row.order_id,
        orderNumber: row.order_number,
        storeId: row.store_id,
        storeName: row.store_name,
        kind: row.kind,
        gateway: row.gateway,
        gatewayPaymentId: row.gateway_payment_id,
        amountPaise: row.amount_paise,
        status: row.status,
        failureCode: row.failure_code,
        paymentMethod: row.payment_method,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  async refunds(filter: RefundFilter): Promise<Page<RefundListItem>> {
    const limit = boundedLimit(filter.limit);
    if (filter.status && !REFUND_STATUSES.has(filter.status)) throw new Error('INVALID_INPUT');
    const cursor = filter.cursor
      ? keyset(JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')))
      : null;
    const conditions: RawBuilder<unknown>[] = [
      filter.storeId ? sql`o.store_id=${filter.storeId}::uuid` : null,
      filter.status ? sql`r.status=${filter.status}` : null,
      filter.from ? sql`r.created_at >= ${isoDateTime(filter.from)}::timestamptz` : null,
      filter.to ? sql`r.created_at < ${isoDateTime(filter.to)}::timestamptz` : null,
      filter.search
        ? sql`(r.refund_reference ILIKE ${`%${escapeLike(filter.search)}%`} OR r.gateway_refund_id ILIKE ${`%${escapeLike(filter.search)}%`} OR o.order_number ILIKE ${`%${escapeLike(filter.search)}%`})`
        : null,
      cursor ? sql`(r.created_at,r.id::text) < (${cursor.c}::timestamptz,${cursor.i})` : null,
    ].filter((entry): entry is RawBuilder<unknown> => entry !== null);
    const rows = await sql<RefundRow>`SELECT r.id::text AS refund_id,r.order_id::text AS order_id,
      o.order_number,o.store_id::text AS store_id,s.name AS store_name,
      r.amount_paise::text AS amount_paise,r.destination,r.status,r.reason,r.created_at
      FROM payment_refunds r
      JOIN orders o ON o.id=r.order_id
      LEFT JOIN stores s ON s.id=o.store_id
      ${conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit + 1}`.execute(this.db);
    return keysetPage(
      rows.rows,
      limit,
      (row) => ({ c: row.created_at.toISOString(), i: row.refund_id }),
      (row) => ({
        refundId: row.refund_id,
        orderId: row.order_id,
        orderNumber: row.order_number,
        storeId: row.store_id,
        storeName: row.store_name,
        amountPaise: row.amount_paise,
        destination: row.destination,
        status: row.status,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  async inventorySummary(filter: InventorySummaryFilter): Promise<Page<InventorySummaryItem>> {
    // The portal renders the full catalog at once (names join onto report rows),
    // so this read allows up to 200 rows per page and defaults to it.
    const limit = boundedLimit(filter.limit, 200, 200);
    if (filter.cursor && !/^[A-Za-z0-9_-]{1,64}$/.test(filter.cursor))
      throw new Error('INVALID_CURSOR');
    if (filter.search !== undefined && filter.search.trim().length < 2)
      throw new Error('INVALID_SEARCH_QUERY');
    const search = filter.search ? `%${escapeLike(filter.search.trim())}%` : null;
    const rows = await sql<InventoryRow>`SELECT v.id::text AS variant_id,v.sku,p.name,
      COALESCE(SUM(si.on_hand),0)::text AS units,
      COUNT(DISTINCT si.store_id) FILTER (WHERE si.on_hand - si.reserved > 0)::int AS available_stores,
      COUNT(DISTINCT si.store_id) FILTER (WHERE si.on_hand - si.reserved > 0 AND si.on_hand - si.reserved <= ${LOW_STOCK_UNITS})::int AS low_stock_stores,
      COALESCE(SUM(si.reserved),0)::text AS total_reserved
      FROM catalog_variants v
      JOIN catalog_products p ON p.id=v.product_id
      LEFT JOIN store_inventory si ON si.variant_id=v.id
      WHERE v.deleted_at IS NULL
        ${filter.cursor ? sql`AND v.id > ${filter.cursor}::uuid` : sql``}
        ${search ? sql`AND (v.sku ILIKE ${search} OR p.normalized_name ILIKE ${search})` : sql``}
      GROUP BY v.id,v.sku,p.name
      ORDER BY v.id
      LIMIT ${limit + 1}`.execute(this.db);
    const page = rows.rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        variantId: row.variant_id,
        sku: row.sku,
        name: row.name,
        units: row.units,
        availableStores: row.available_stores,
        lowStockStores: row.low_stock_stores,
        totalReserved: row.total_reserved,
      })),
      nextCursor: rows.rows.length > limit ? (page.at(-1)?.variant_id ?? null) : null,
    };
  }

  async ratings(filter: RatingsFilter): Promise<Page<RatingListItem>> {
    const limit = boundedLimit(filter.limit);
    const queueOnly = filter.queueOnly === true;
    const cursor = filter.cursor
      ? keyset(JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')))
      : null;
    const rows = await sql<RatingRow>`SELECT r.id::text AS rating_id,r.order_id::text AS order_id,
      o.order_number,r.rater_id::text AS rater_id,u.name AS rater_name,r.target_type,
      r.target_id::text AS target_id,r.stars::int AS stars,r.comment,r.hidden,r.created_at
      FROM ratings r
      JOIN orders o ON o.id=r.order_id
      JOIN users u ON u.id=r.rater_id
      WHERE ${
        cursor
          ? queueOnly
            ? sql`(r.created_at,r.id::text) > (${cursor.c}::timestamptz,${cursor.i})`
            : sql`(r.created_at,r.id::text) < (${cursor.c}::timestamptz,${cursor.i})`
          : sql`TRUE`
      }
        ${queueOnly ? sql`AND NOT r.hidden AND r.comment IS NOT NULL` : sql``}
      ORDER BY r.created_at ${queueOnly ? sql`ASC` : sql`DESC`},r.id ${queueOnly ? sql`ASC` : sql`DESC`}
      LIMIT ${limit + 1}`.execute(this.db);
    return keysetPage(
      rows.rows,
      limit,
      (row) => ({ c: row.created_at.toISOString(), i: row.rating_id }),
      (row) => ({
        ratingId: row.rating_id,
        orderId: row.order_id,
        orderNumber: row.order_number,
        raterUserId: row.rater_id,
        raterName: row.rater_name,
        targetType: row.target_type,
        targetId: row.target_id,
        stars: row.stars,
        comment: row.comment,
        hidden: row.hidden,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  async legalHolds(cursor: string | undefined, limit: number): Promise<Page<LegalHoldListItem>> {
    const bounded = boundedLimit(limit);
    const key = cursor
      ? keyset(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
      : null;
    const rows = await sql<HoldRow>`SELECT h.id::text AS hold_id,h.user_id::text AS user_id,
      u.normalized_email AS user_email,u.name AS user_name,h.reason,h.created_by::text AS created_by,
      h.created_at,h.released_at
      FROM privacy_legal_holds h JOIN users u ON u.id=h.user_id
      ${key ? sql`WHERE (h.created_at,h.id::text) < (${key.c}::timestamptz,${key.i})` : sql``}
      ORDER BY h.created_at DESC,h.id DESC LIMIT ${bounded + 1}`.execute(this.db);
    return keysetPage(
      rows.rows,
      bounded,
      (row) => ({ c: row.created_at.toISOString(), i: row.hold_id }),
      (row) => ({
        holdId: row.hold_id,
        userId: row.user_id,
        userEmail: row.user_email,
        userName: row.user_name,
        reason: row.reason,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString(),
        releasedAt: row.released_at?.toISOString() ?? null,
      }),
    );
  }

  async search(query: { q: string }): Promise<GlobalSearchView> {
    const term = query.q?.trim() ?? '';
    if (term.length < 2 || term.length > 64) throw new Error('INVALID_SEARCH_QUERY');
    const pattern = `%${escapeLike(term)}%`;
    const prefix = `${escapeLike(term)}%`;
    const [stores, products, orders, customers, riders, tickets] = await Promise.all([
      sql<{
        id: string;
        title: string;
        sub: string | null;
      }>`SELECT id::text AS id,name AS title,status AS sub
        FROM stores WHERE name ILIKE ${pattern} ORDER BY name,id LIMIT ${SEARCH_ITEMS_PER_GROUP}`.execute(
        this.db,
      ),
      sql<{
        id: string;
        title: string;
        sub: string | null;
      }>`SELECT id::text AS id,name AS title,NULL AS sub
        FROM catalog_products WHERE published AND deleted_at IS NULL AND normalized_name ILIKE ${pattern}
        ORDER BY normalized_name,id LIMIT ${SEARCH_ITEMS_PER_GROUP}`.execute(this.db),
      sql<{
        id: string;
        title: string;
        sub: string | null;
      }>`SELECT id::text AS id,order_number AS title,status AS sub
        FROM orders WHERE order_number ILIKE ${prefix} ORDER BY placed_at DESC,id LIMIT ${SEARCH_ITEMS_PER_GROUP}`.execute(
        this.db,
      ),
      sql<{
        id: string;
        title: string;
        sub: string | null;
      }>`SELECT id::text AS id,name AS title,normalized_email AS sub
        FROM users WHERE pool='CUSTOMER' AND (normalized_email ILIKE ${pattern} OR name ILIKE ${pattern})
        ORDER BY normalized_email,id LIMIT ${SEARCH_ITEMS_PER_GROUP}`.execute(this.db),
      sql<{
        id: string;
        title: string;
        sub: string | null;
      }>`SELECT u.id::text AS id,u.name AS title,u.normalized_email AS sub
        FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='RIDER'
        WHERE u.name ILIKE ${pattern} OR u.normalized_email ILIKE ${pattern}
        ORDER BY u.normalized_email,u.id LIMIT ${SEARCH_ITEMS_PER_GROUP}`.execute(this.db),
      sql<{
        id: string;
        title: string;
        sub: string | null;
      }>`SELECT t.id::text AS id,t.category AS title,t.status AS sub
        FROM support_tickets t WHERE t.id::text ILIKE ${prefix} OR t.category ILIKE ${pattern}
        ORDER BY t.created_at DESC,t.id LIMIT ${SEARCH_ITEMS_PER_GROUP}`.execute(this.db),
    ]);
    const groups: GlobalSearchView['groups'] = (
      [
        ['Stores', stores.rows],
        ['Products', products.rows],
        ['Orders', orders.rows],
        ['Customers', customers.rows],
        ['Riders', riders.rows],
        ['Tickets', tickets.rows],
      ] as const
    )
      .filter(([, items]) => items.length > 0)
      .map(([group, items]) => ({ group: group as GlobalSearchGroup, items }));
    return { groups };
  }
}

interface PaymentAttemptRow {
  attempt_id: string;
  order_id: string | null;
  order_number: string | null;
  store_id: string | null;
  store_name: string | null;
  kind: 'ORDER_PAYMENT' | 'WALLET_TOPUP';
  gateway: string;
  gateway_payment_id: string | null;
  amount_paise: string;
  status: string;
  failure_code: string | null;
  payment_method: string | null;
  created_at: Date;
}
interface RefundRow {
  refund_id: string;
  order_id: string;
  order_number: string | null;
  store_id: string | null;
  store_name: string | null;
  amount_paise: string;
  destination: string;
  status: string;
  reason: string | null;
  created_at: Date;
}
interface InventoryRow {
  variant_id: string;
  sku: string;
  name: string;
  units: string;
  available_stores: number;
  low_stock_stores: number;
  total_reserved: string;
}
interface RatingRow {
  rating_id: string;
  order_id: string;
  order_number: string | null;
  rater_id: string;
  rater_name: string | null;
  target_type: string;
  target_id: string;
  stars: number;
  comment: string | null;
  hidden: boolean;
  created_at: Date;
}
interface HoldRow {
  hold_id: string;
  user_id: string;
  user_email: string;
  user_name: string | null;
  reason: string;
  created_by: string;
  created_at: Date;
  released_at: Date | null;
}

function keysetPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  key: (row: Row) => Keyset,
  map: (row: Row) => Item,
): Page<Item> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(map),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(key(last)) : null,
  };
}
