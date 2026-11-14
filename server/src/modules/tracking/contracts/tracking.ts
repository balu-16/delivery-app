import type { Json } from '../../../platform/database/database.js';

/**
 * Tracking contracts (P8): GPS ingest with integrity/sampling rules, the
 * Redis GEO candidate index, rider location reads and the v1 ETA provider.
 * Realtime emission goes through REALTIME_BROADCASTS (rider rooms and
 * customer order rooms); dispatch binds the active-order resolver at boot
 * (dependency inversion: tracking must not import dispatch).
 */

export interface Point {
  lat: number;
  lng: number;
}

export interface LocationPointInput {
  /** Client timestamp; future skew and out-of-order points are dropped. */
  ts: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  speedMps?: number;
  isMock?: boolean;
  batteryPct?: number;
}

export interface IngestOutcome {
  accepted: number;
  rejected: { count: number; reasons: Record<string, number> };
  persisted: number;
}

export const LOCATION_INGEST = Symbol('LOCATION_INGEST');
export interface LocationIngest {
  ingestBatch(riderId: string, points: readonly LocationPointInput[]): Promise<IngestOutcome>;
}

export const RIDER_GEO = Symbol('RIDER_GEO');
export interface RiderGeo {
  /**
   * GEO prefilter only: candidate rider ids near the point. Membership never
   * proves eligibility; dispatch revalidates through RIDER_ELIGIBILITY.
   */
  candidatesNear(point: Point, radiusMetres: number, limit: number): Promise<string[]>;
  /** Removes a stale member (freshness pruning is best-effort). */
  refreshTtl(riderId: string, ttlSeconds: number): Promise<void>;
}

export interface RiderLastLocation {
  riderId: string;
  location: Point;
  at: string;
  speedMps: number | null;
}

export const RIDER_LOCATION_READS = Symbol('RIDER_LOCATION_READS');
export interface RiderLocationReads {
  lastLocation(riderId: string): Promise<RiderLastLocation | null>;
}

export interface EtaRange {
  minMinutes: number;
  maxMinutes: number;
}

export interface EtaInput {
  /** Straight-line legs; the provider may consult cached directions. */
  riderToStoreMetres?: number;
  storeToCustomerMetres: number;
  /** Seconds of remaining preparation before the parcel can leave. */
  remainingPrepSeconds?: number;
  pickedUp: boolean;
}

/**
 * ETA v1 (23.5): haversine × road factor ÷ average speed with a range.
 * Published only when it moves by the configured delta (anti-jitter).
 */
export const ETA_PROVIDER = Symbol('ETA_PROVIDER');
export interface EtaProvider {
  eta(input: EtaInput): Promise<EtaRange>;
}

export interface ActiveOrderState {
  orderId: string;
  customerUserId: string | null;
  /** Delivery task status (custody window ASSIGNED..ARRIVED is visible). */
  taskStatus: string;
}

/** Implemented and bound by dispatch at boot (tracking stays dispatch-free). */
export const ACTIVE_ORDER_RESOLVER = Symbol('ACTIVE_ORDER_RESOLVER');
export interface ActiveOrderResolver {
  activeOrderForRider(riderId: string): Promise<ActiveOrderState | null>;
  activeOrdersForRider?(riderId: string): Promise<ActiveOrderState[]>;
}

/** Boot-time registry; dispatch registers the implementation. */
export class ActiveOrderResolverHolder {
  private impl: ActiveOrderResolver | null = null;
  register(impl: ActiveOrderResolver): void {
    this.impl = impl;
  }
  get(): ActiveOrderResolver | null {
    return this.impl;
  }
}

export const REALTIME_BROADCASTS = Symbol('REALTIME_BROADCASTS');
export interface RealtimeBroadcasts {
  /** Rider self room `user:{id}`; offers and task updates. */
  emitRiderEvent(riderId: string, event: string, payload: Json): void;
  /** Customer order room `order:{id}`; statuses, ETA and throttled location. */
  emitOrderEvent(orderId: string, event: string, payload: Json): void;
  /** Location stream is throttled to ≥ 3s per order (23.4). */
  emitOrderLocation(orderId: string, payload: Json): void;
}

/** Registry of the namespace handles registered by the dispatch lifecycles. */
export interface NamespaceRegistryPort {
  register(handle: import('../../../platform/realtime/realtime.js').RealtimeNamespace): void;
  get(
    name: '/rider' | '/customer',
  ): import('../../../platform/realtime/realtime.js').RealtimeNamespace | null;
}
