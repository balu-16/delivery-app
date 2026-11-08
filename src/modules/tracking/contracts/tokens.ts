export {
  ACTIVE_ORDER_RESOLVER,
  ETA_PROVIDER,
  LOCATION_INGEST,
  REALTIME_BROADCASTS,
  RIDER_GEO,
  RIDER_LOCATION_READS,
} from './tracking.js';

/** Holder token: dispatch registers the active-order resolver at boot. */
export const ACTIVE_ORDER_RESOLVER_HOLDER = Symbol('ACTIVE_ORDER_RESOLVER_HOLDER');
/** Namespace handle registry shared by the dispatch realtime lifecycles. */
export const NAMESPACE_REGISTRY = Symbol('NAMESPACE_REGISTRY');
