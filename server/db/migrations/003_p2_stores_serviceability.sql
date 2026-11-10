-- P2 stores, zones, addresses. Requires 002_p1_identity and PostGIS from 001.
-- New tables only; store FKs are added to the initially empty P1 assignment tables.
-- Production recovery: apply a forward correction; DOWN is development/test only and destroys P2 data.
-- Up Migration
CREATE TABLE legal_entities (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cities (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(trim(name)) > 0),
  bounds geometry(Polygon, 4326) NOT NULL CHECK (ST_IsValid(bounds) AND NOT ST_IsEmpty(bounds)),
  zone_version bigint NOT NULL DEFAULT 1 CHECK (zone_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE stores (
  id uuid PRIMARY KEY, legal_entity_id uuid NOT NULL REFERENCES legal_entities(id), city_id uuid NOT NULL REFERENCES cities(id),
  name text NOT NULL CHECK (length(trim(name)) > 0), location geography(Point, 4326) NOT NULL,
  status text NOT NULL CHECK (status IN ('ONLINE', 'PAUSED', 'OFFLINE')),
  pause_reason text, last_order_buffer_minutes integer NOT NULL DEFAULT 0 CHECK (last_order_buffer_minutes >= 0),
  hourly_capacity integer NOT NULL CHECK (hourly_capacity >= 0), version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'PAUSED' OR (pause_reason IS NOT NULL AND length(trim(pause_reason)) > 0))
);
-- City listing and legal-entity membership.
CREATE INDEX stores_city_idx ON stores(city_id, id);
CREATE INDEX stores_legal_entity_idx ON stores(legal_entity_id);
CREATE TABLE store_status_history (
  store_id uuid NOT NULL REFERENCES stores(id), version bigint NOT NULL,
  previous_status text NOT NULL, status text NOT NULL, reason text,
  actor_id uuid REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(store_id, version)
);
CREATE TABLE store_hours (
  store_id uuid NOT NULL REFERENCES stores(id), weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 0 AND 1440 AND end_minute <> start_minute),
  PRIMARY KEY(store_id, weekday, start_minute)
);
CREATE TABLE store_holidays (
  store_id uuid NOT NULL REFERENCES stores(id), day date NOT NULL, closed boolean NOT NULL,
  PRIMARY KEY(store_id, day)
);
CREATE TABLE store_holiday_hours (
  store_id uuid NOT NULL, day date NOT NULL,
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 0 AND 1440 AND end_minute <> start_minute),
  PRIMARY KEY(store_id, day, start_minute),
  FOREIGN KEY(store_id, day) REFERENCES store_holidays(store_id, day) ON DELETE CASCADE
);
CREATE TABLE zones (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), name text NOT NULL CHECK (length(trim(name)) > 0),
  polygon geometry(MultiPolygon, 4326) NOT NULL CHECK (ST_IsValid(polygon) AND NOT ST_IsEmpty(polygon)),
  priority integer NOT NULL, active boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Point-in-polygon and store ownership.
CREATE INDEX zones_polygon_idx ON zones USING gist(polygon) WHERE active;
CREATE INDEX zones_store_idx ON zones(store_id, id);
CREATE TABLE addresses (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), line1 text NOT NULL, line2 text, landmark text,
  pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'), contact_name text NOT NULL CHECK (length(trim(contact_name)) > 0),
  contact_phone text NOT NULL CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  point geography(Point, 4326) NOT NULL, is_default boolean NOT NULL DEFAULT false,
  deleted_at timestamptz, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT is_default OR deleted_at IS NULL)
);
-- One default maximum; serialized mutations ensure exactly one whenever any address is active.
CREATE UNIQUE INDEX addresses_one_default_idx ON addresses(user_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX addresses_owner_active_idx ON addresses(user_id, created_at, id) WHERE deleted_at IS NULL;
CREATE TABLE store_operational_signals (
  store_id uuid PRIMARY KEY REFERENCES stores(id), pick_backlog integer CHECK (pick_backlog >= 0),
  no_riders_since timestamptz, observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE store_capacity_buckets (
  store_id uuid NOT NULL REFERENCES stores(id), slot_start timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity >= 0), claimed integer NOT NULL DEFAULT 0 CHECK (claimed >= 0 AND claimed <= capacity),
  PRIMARY KEY(store_id, slot_start)
);
CREATE TABLE store_capacity_claims (
  store_id uuid NOT NULL, slot_start timestamptz NOT NULL, reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(store_id, slot_start, reference),
  FOREIGN KEY(store_id, slot_start) REFERENCES store_capacity_buckets(store_id, slot_start)
);
ALTER TABLE store_staff ADD CONSTRAINT store_staff_store_fk FOREIGN KEY (store_id) REFERENCES stores(id);
ALTER TABLE rider_profiles ADD CONSTRAINT rider_profiles_home_store_fk FOREIGN KEY (home_store_id) REFERENCES stores(id);
CREATE INDEX rider_profiles_home_store_idx ON rider_profiles(home_store_id) WHERE home_store_id IS NOT NULL;
-- Down Migration
DROP INDEX rider_profiles_home_store_idx;
ALTER TABLE rider_profiles DROP CONSTRAINT rider_profiles_home_store_fk;
ALTER TABLE store_staff DROP CONSTRAINT store_staff_store_fk;
DROP TABLE store_capacity_claims;
DROP TABLE store_capacity_buckets;
DROP TABLE store_operational_signals;
DROP TABLE addresses;
DROP TABLE zones;
DROP TABLE store_holiday_hours;
DROP TABLE store_holidays;
DROP TABLE store_hours;
DROP TABLE store_status_history;
DROP TABLE stores;
DROP TABLE cities;
DROP TABLE legal_entities;
