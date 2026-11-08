-- P5 owns carts, quote snapshots, coupons and checkout intents (D15). Money columns are
-- bigint paise; order references stay FK-free until P6 introduces the orders tables.
-- Up Migration
CREATE TABLE carts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id), address_id uuid NOT NULL REFERENCES addresses(id),
 store_id uuid NOT NULL REFERENCES stores(id), coupon_code text,
 CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX carts_store_idx ON carts(store_id, user_id);
CREATE TABLE cart_items (
 cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE, variant_id uuid NOT NULL REFERENCES catalog_variants(id),
 quantity bigint NOT NULL CHECK (quantity > 0), unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
 mrp_paise bigint NOT NULL CHECK (mrp_paise >= 0), tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 100000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (cart_id, variant_id)
);
CREATE TABLE quote_snapshots (
 id uuid PRIMARY KEY, cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE, cart_version bigint NOT NULL CHECK (cart_version > 0),
 user_id uuid NOT NULL REFERENCES users(id), store_id uuid NOT NULL REFERENCES stores(id), address_id uuid NOT NULL REFERENCES addresses(id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED','SUPERSEDED')),
 lines jsonb NOT NULL, fees jsonb NOT NULL, issues jsonb NOT NULL DEFAULT '[]'::jsonb, wallet jsonb,
 coupon_code text, coupon_discount_paise bigint NOT NULL DEFAULT 0 CHECK (coupon_discount_paise >= 0),
 subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0), discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
 fee_total_paise bigint NOT NULL DEFAULT 0 CHECK (fee_total_paise >= 0), tax_total_paise bigint NOT NULL DEFAULT 0 CHECK (tax_total_paise >= 0),
 tip_paise bigint NOT NULL DEFAULT 0 CHECK (tip_paise >= 0), total_paise bigint NOT NULL CHECK (total_paise >= 0),
 amount_due_paise bigint NOT NULL CHECK (amount_due_paise >= 0),
 price_version bigint NOT NULL CHECK (price_version > 0), config_version bigint NOT NULL CHECK (config_version >= 0),
 coupon_fingerprint text, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (consumed_at IS NULL OR status = 'CONSUMED')
);
-- Refresh supersedes prior ACTIVE snapshots, so a cart holds at most one live quote.
CREATE UNIQUE INDEX quote_snapshots_cart_active_idx ON quote_snapshots(cart_id) WHERE status = 'ACTIVE';
CREATE INDEX quote_snapshots_user_idx ON quote_snapshots(user_id, status, created_at DESC);
CREATE TABLE coupons (
 id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
 kind text NOT NULL CHECK (kind IN ('PERCENT','FLAT','FREE_DELIVERY')),
 value bigint NOT NULL,
 max_cap_paise bigint CHECK (max_cap_paise IS NULL OR max_cap_paise > 0),
 min_order_paise bigint NOT NULL DEFAULT 0 CHECK (min_order_paise >= 0),
 per_user_limit integer CHECK (per_user_limit IS NULL OR per_user_limit > 0),
 global_limit integer CHECK (global_limit IS NULL OR global_limit > 0),
 redeemed_count integer NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
 valid_from timestamptz, valid_to timestamptz,
 store_id uuid REFERENCES stores(id), category_id uuid REFERENCES catalog_categories(id), product_id uuid REFERENCES catalog_products(id),
 excluded_variant_ids uuid[] NOT NULL DEFAULT '{}',
 stackable boolean NOT NULL DEFAULT false, first_order_only boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
 CHECK (kind <> 'PERCENT' OR (value BETWEEN 1 AND 10000)),
 CHECK (kind <> 'FLAT' OR value > 0),
 CHECK (kind <> 'FREE_DELIVERY' OR value = 0)
);
CREATE INDEX coupons_scope_idx ON coupons(store_id, active, code);
CREATE INDEX coupons_validity_idx ON coupons(active, valid_from, valid_to);
CREATE TABLE coupon_user_quota (
 coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id),
 reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0), committed_count integer NOT NULL DEFAULT 0 CHECK (committed_count >= 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (coupon_id, user_id)
);
CREATE TABLE coupon_redemptions (
 id uuid PRIMARY KEY, coupon_id uuid NOT NULL REFERENCES coupons(id), user_id uuid NOT NULL REFERENCES users(id),
 order_id uuid, state text NOT NULL CHECK (state IN ('RESERVED','COMMITTED','RELEASED')),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), committed_at timestamptz, released_at timestamptz,
 CHECK (state <> 'COMMITTED' OR order_id IS NOT NULL),
 CHECK ((state = 'COMMITTED') = (committed_at IS NOT NULL)),
 CHECK ((state = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE INDEX coupon_redemptions_user_idx ON coupon_redemptions(coupon_id, user_id, state);
CREATE UNIQUE INDEX coupon_redemptions_order_idx ON coupon_redemptions(coupon_id, order_id) WHERE order_id IS NOT NULL;
CREATE TABLE checkout_intents (
 id uuid PRIMARY KEY, cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
 cart_version bigint NOT NULL CHECK (cart_version > 0), quote_id uuid NOT NULL REFERENCES quote_snapshots(id),
 state text NOT NULL DEFAULT 'ISSUED' CHECK (state IN ('ISSUED','CONSUMED')),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (cart_id, cart_version),
 CHECK (state <> 'CONSUMED' OR consumed_at IS NOT NULL)
);
CREATE INDEX checkout_intents_expiry_idx ON checkout_intents(expires_at) WHERE state = 'ISSUED';
-- Down Migration
DROP TABLE checkout_intents;
DROP TABLE coupon_redemptions;
DROP TABLE coupon_user_quota;
DROP TABLE coupons;
DROP TABLE quote_snapshots;
DROP TABLE cart_items;
DROP TABLE carts;
