import { sql } from 'kysely';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import { type CartService } from '../../cart/contracts/cart.js';
import type { ReorderResult } from '../contracts/orders.js';
import { PostgresOrderAggregate } from './postgres-orders.js';

/**
 * Same-zone, fee-preserving, pre-PICKING address guard (GEO-03). Semantics
 * use the persisted order zone and delivery fee. The selected address is
 * read from the customer’s current address record.
 */
export function ensureAddressChangeAllowed(value: {
  status: string;
  originalZoneId: string;
  newZoneId: string;
  originalDeliveryFeePaise: bigint;
  newDeliveryFeePaise: bigint;
}): void {
  if (
    !['PENDING_PAYMENT', 'CONFIRMED'].includes(value.status) ||
    value.originalZoneId !== value.newZoneId ||
    value.originalDeliveryFeePaise !== value.newDeliveryFeePaise
  ) {
    throw new Error('ADDRESS_CHANGE_NOT_ALLOWED');
  }
}

/**
 * Customer order mutations beyond the lifecycle: the guarded address change
 * and reorder. Reorder builds a NEW cart from previous items at current
 * prices and availability; it never places an order and lists unavailable
 * lines as issues (Section 21).
 */
export class OrderMutationsService {
  constructor(
    private readonly db: Database,
    private readonly aggregate: PostgresOrderAggregate,
    private readonly carts: CartService,
  ) {}
  async changeAddress(
    orderId: string,
    userId: string,
    input: { addressId: string; addressSnapshot: Record<string, unknown> },
  ): Promise<void> {
    await transactionWithRetry(this.db, async (tx) => {
      const row = await this.aggregate.lock(tx, orderId);
      if (!row || row.user_id !== userId) throw new Error('ORDER_NOT_FOUND');
      const cutoff =
        await sql`SELECT 1 FROM orders o JOIN subscription_occurrences occ ON occ.order_id=o.id
        WHERE o.id=${orderId}::uuid AND o.source='SUBSCRIPTION' AND clock_timestamp() >=
        (((occ.delivery_date-1) + COALESCE((SELECT value #>> '{}' FROM app_config WHERE key='subscriptionCutoffTime'),'21:00')::time) AT TIME ZONE 'Asia/Kolkata')`.execute(
          tx,
        );
      if (cutoff.rows.length) throw new Error('CUTOFF_PASSED');
      // The order row is locked and rechecked before the guard runs.
      const address = await sql<{
        id: string;
        zone_id: string | null;
        zone_store_id: string | null;
        line1: string;
        line2: string | null;
        landmark: string | null;
        pincode: string;
        contact_name: string;
        contact_phone: string;
        lat: number;
        lng: number;
      }>`SELECT a.id,z.id AS zone_id,z.store_id::text AS zone_store_id,a.line1,a.line2,a.landmark,a.pincode,a.contact_name,a.contact_phone,
        ST_Y(a.point::geometry) AS lat,ST_X(a.point::geometry) AS lng FROM addresses a
        LEFT JOIN LATERAL(SELECT z.id,z.store_id FROM zones z WHERE z.active AND ST_Covers(z.polygon,a.point::geometry)
          ORDER BY z.priority DESC,z.id LIMIT 1)z ON true
        WHERE a.id=${input.addressId}::uuid AND a.user_id=${userId}::uuid AND a.deleted_at IS NULL FOR SHARE OF a`.execute(
        tx,
      );
      const target = address.rows[0];
      if (!target) throw new Error('RESOURCE_NOT_FOUND');
      if (target.zone_store_id !== row.store_id) throw new Error('ADDRESS_CHANGE_NOT_ALLOWED');
      const snapshot = row.address_snapshot as {
        zoneId?: string;
        zoneVersion?: string;
        cityZoneVersion?: string;
        deliveryFeePaise?: string;
      };
      // Fees are a function of (store, zone, order value): same store+zone and
      // a frozen order value keep the delivery fee unchanged by construction.
      ensureAddressChangeAllowed({
        status: row.status,
        originalZoneId: snapshot.zoneId ?? '',
        newZoneId: target.zone_id ?? '',
        originalDeliveryFeePaise: BigInt(snapshot.deliveryFeePaise ?? '0'),
        newDeliveryFeePaise: BigInt(snapshot.deliveryFeePaise ?? '0'),
      });
      await sql`UPDATE orders SET address_snapshot=${JSON.stringify({
        line1: target.line1,
        line2: target.line2,
        landmark: target.landmark,
        pincode: target.pincode,
        contactName: target.contact_name,
        contactPhone: target.contact_phone,
        lat: target.lat,
        lng: target.lng,
        zoneId: target.zone_id,
        ...(snapshot.zoneVersion ? { zoneVersion: snapshot.zoneVersion } : {}),
        ...(snapshot.cityZoneVersion ? { cityZoneVersion: snapshot.cityZoneVersion } : {}),
        deliveryFeePaise: snapshot.deliveryFeePaise ?? '0',
        addressId: target.id,
      })}::jsonb,version=version+1,updated_at=clock_timestamp()
        WHERE id=${orderId}::uuid`.execute(tx);
      await this.aggregate.history(tx, orderId, row.status, row.status, 'ADDRESS_CHANGED', {
        type: 'CUSTOMER',
        id: userId,
      });
    });
  }
  async reorder(orderId: string, userId: string): Promise<ReorderResult> {
    const row = await this.aggregate.byIdRaw(orderId);
    if (!row || row.user_id !== userId) throw new Error('ORDER_NOT_FOUND');
    const items = await this.aggregate.items(orderId);
    if (!items.length) throw new Error('INVALID_INPUT');
    const snapshot = row.address_snapshot as Record<string, unknown>;
    let addressId =
      typeof snapshot['addressId'] === 'string'
        ? snapshot['addressId']
        : typeof snapshot['id'] === 'string'
          ? snapshot['id']
          : null;
    if (!addressId) {
      // A snapshot without an address reference falls back to the user's
      // default address so reorder always targets a bindable cart.
      const fallback = await sql<{ id: string }>`SELECT id FROM addresses
        WHERE user_id=${userId}::uuid AND deleted_at IS NULL
        ORDER BY is_default DESC, created_at LIMIT 1`.execute(this.db);
      addressId = fallback.rows[0]?.id ?? null;
    }
    if (!addressId) throw new Error('INVALID_INPUT');
    const targetAddress = addressId;
    return transactionWithRetry(this.db, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cart-user:${userId}`},0))`.execute(
        tx,
      );
      const old = await this.carts.get(userId, tx);
      if (old) await this.carts.deleteCart(userId, { expectedVersion: old.version, tx });
      const cart = await this.carts.getOrCreateActiveCart(userId, targetAddress, tx);
      const added: { variantId: string; quantity: string }[] = [];
      const issues: { variantId: string; code: string }[] = [];
      let version = cart.version;
      for (const item of items) {
        try {
          const result = await this.carts.putItem(userId, item.variantId, item.orderedQty, {
            expectedVersion: version,
            tx,
          });
          version = result.cart.version;
          const line = result.cart.lines.find((entry) => entry.variantId === item.variantId);
          if (line) added.push({ variantId: item.variantId, quantity: line.quantity });
          if (!line || BigInt(line.quantity) < BigInt(item.orderedQty)) {
            issues.push({
              variantId: item.variantId,
              code: line ? 'QTY_REDUCED' : 'ITEM_UNAVAILABLE',
            });
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (!['INVENTORY_INSUFFICIENT', 'RESOURCE_NOT_FOUND', 'INVALID_INPUT'].includes(code))
            throw error;
          issues.push({
            variantId: item.variantId,
            code: code === 'INVALID_INPUT' ? 'CART_LIMIT_REACHED' : 'ITEM_UNAVAILABLE',
          });
        }
      }
      return { cartId: cart.cartId, added, issues };
    });
  }
}
