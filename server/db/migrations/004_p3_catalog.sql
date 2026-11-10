-- P3 catalog, temporal prices, media metadata and inventory assortment.
-- DOWN destroys P3 data; production recovery uses a forward migration.
-- Up Migration
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE catalog_categories (
 id uuid PRIMARY KEY, name text NOT NULL CHECK (length(trim(name)) > 0),
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE catalog_brands (
 id uuid PRIMARY KEY, name text NOT NULL CHECK (length(trim(name)) > 0),
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE catalog_products (
 id uuid PRIMARY KEY, category_id uuid NOT NULL REFERENCES catalog_categories(id), brand_id uuid REFERENCES catalog_brands(id),
 name text NOT NULL CHECK (length(trim(name)) > 0), normalized_name text NOT NULL,
 description text NOT NULL DEFAULT '', hsn_code text, gst_rate_bps integer, perishable boolean NOT NULL DEFAULT false,
 expiry_tracking boolean NOT NULL DEFAULT false, published boolean NOT NULL DEFAULT false, popularity integer NOT NULL DEFAULT 0 CHECK (popularity >= 0),
 publication_version bigint NOT NULL DEFAULT 1 CHECK(publication_version>0), deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (NOT published OR deleted_at IS NULL)
);
CREATE TABLE catalog_publication_history (
 product_id uuid NOT NULL REFERENCES catalog_products(id), version bigint NOT NULL, previous_published boolean NOT NULL,
 published boolean NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL,
 PRIMARY KEY(product_id,version), CHECK(previous_published<>published)
);
CREATE INDEX catalog_products_name_trgm_idx ON catalog_products USING gin(normalized_name gin_trgm_ops);
CREATE INDEX catalog_products_name_fts_idx ON catalog_products USING gin(to_tsvector('simple', normalized_name));
CREATE INDEX catalog_products_category_idx ON catalog_products(category_id, id) WHERE deleted_at IS NULL AND published;
CREATE TABLE catalog_variants (
 id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES catalog_products(id), name text NOT NULL CHECK (length(trim(name)) > 0),
 sku text NOT NULL UNIQUE CHECK (length(trim(sku)) > 0), barcode text UNIQUE, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX catalog_variants_product_idx ON catalog_variants(product_id, id) WHERE deleted_at IS NULL;
-- P4 owns quantities and will add ledger-backed mutations; P3 only creates zero rows.
CREATE TABLE store_inventory (
 store_id uuid NOT NULL REFERENCES stores(id), variant_id uuid NOT NULL REFERENCES catalog_variants(id),
 on_hand bigint NOT NULL DEFAULT 0 CHECK (on_hand >= 0), reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0), PRIMARY KEY(store_id, variant_id)
);
CREATE VIEW inventory_saleable_availability AS SELECT store_id,variant_id,(on_hand-reserved)::bigint AS available,NULL::timestamptz AS next_change FROM store_inventory;
CREATE TABLE catalog_prices (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), variant_id uuid NOT NULL REFERENCES catalog_variants(id),
 selling_paise bigint NOT NULL CHECK (selling_paise >= 0), mrp_paise bigint NOT NULL CHECK (mrp_paise >= selling_paise),
 valid_from timestamptz NOT NULL, valid_to timestamptz, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK (valid_to IS NULL OR valid_to > valid_from),
 EXCLUDE USING gist (store_id WITH =, variant_id WITH =, tstzrange(valid_from,valid_to,'[)') WITH &&)
);
CREATE INDEX catalog_prices_lookup_idx ON catalog_prices(store_id,variant_id,valid_from DESC);
CREATE TABLE catalog_media (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK (purpose IN ('PRODUCT_IMAGE','CATALOG_IMPORT','IMPORT_REPORT')),
 object_key text NOT NULL UNIQUE, content_type text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes > 0),
 state text NOT NULL CHECK (state IN ('PENDING','REGISTERED')), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), registered_at timestamptz
);
CREATE INDEX catalog_media_orphan_idx ON catalog_media(expires_at) WHERE state='PENDING';
CREATE TABLE media_orphan_objects (
 object_key text PRIMARY KEY, remove_after timestamptz NOT NULL, lease_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX media_orphan_due_idx ON media_orphan_objects(remove_after);
CREATE TABLE catalog_product_images (
 product_id uuid NOT NULL REFERENCES catalog_products(id), media_id uuid NOT NULL REFERENCES catalog_media(id),
 position integer NOT NULL DEFAULT 0 CHECK (position >= 0), PRIMARY KEY(product_id,media_id)
);
CREATE TABLE catalog_synonyms (term text PRIMARY KEY, expansion text NOT NULL CHECK (length(trim(expansion)) > 0));
CREATE TABLE catalog_revision (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), revision bigint NOT NULL DEFAULT 1);
INSERT INTO catalog_revision(singleton) VALUES (true);
CREATE FUNCTION bump_catalog_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE singleton; RETURN NULL; END $$;
CREATE TRIGGER catalog_categories_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_categories FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER catalog_brands_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_brands FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER catalog_products_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_products FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER catalog_variants_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_variants FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER store_inventory_revision AFTER INSERT OR UPDATE OR DELETE ON store_inventory FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER catalog_prices_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_prices FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER catalog_images_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_product_images FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER catalog_synonyms_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_synonyms FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TABLE catalog_import_jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), media_id uuid NOT NULL REFERENCES catalog_media(id),
 fingerprint text NOT NULL UNIQUE, dry_run boolean NOT NULL, options jsonb NOT NULL, status text NOT NULL CHECK(status IN ('QUEUED','VALIDATING','AWAITING_APPROVAL','APPLYING','COMPLETED','FAILED')),
 checkpoint integer NOT NULL DEFAULT 0, rows_total integer NOT NULL DEFAULT 0, errors jsonb NOT NULL DEFAULT '[]'::jsonb,
 report_key text, report_errors jsonb, report_lease_token uuid, report_lease_until timestamptz,
 lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), approval_id uuid REFERENCES maker_checker_requests(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE catalog_import_status_history (
 job_id uuid NOT NULL REFERENCES catalog_import_jobs(id), sequence bigint GENERATED ALWAYS AS IDENTITY,
 previous_status text, status text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,sequence)
);
CREATE FUNCTION catalog_record_import_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN INSERT INTO catalog_import_status_history(job_id,previous_status,status) VALUES(NEW.id,NULL,NEW.status);
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN INSERT INTO catalog_import_status_history(job_id,previous_status,status) VALUES(NEW.id,OLD.status,NEW.status); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_import_status_history_trigger AFTER INSERT OR UPDATE OF status ON catalog_import_jobs FOR EACH ROW EXECUTE FUNCTION catalog_record_import_status();
CREATE INDEX catalog_import_recovery_idx ON catalog_import_jobs(status,lease_until);
CREATE TABLE catalog_import_rows (job_id uuid NOT NULL REFERENCES catalog_import_jobs(id), row_number integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY(job_id,row_number));
-- Down Migration
DROP TABLE catalog_import_rows;
DROP TRIGGER catalog_import_status_history_trigger ON catalog_import_jobs;
DROP FUNCTION catalog_record_import_status();
DROP TABLE catalog_import_status_history;
DROP TABLE catalog_import_jobs;
DROP TRIGGER catalog_synonyms_revision ON catalog_synonyms;
DROP TRIGGER catalog_images_revision ON catalog_product_images;
DROP TRIGGER catalog_prices_revision ON catalog_prices;
DROP TRIGGER store_inventory_revision ON store_inventory;
DROP TRIGGER catalog_variants_revision ON catalog_variants;
DROP TRIGGER catalog_products_revision ON catalog_products;
DROP TRIGGER catalog_brands_revision ON catalog_brands;
DROP TRIGGER catalog_categories_revision ON catalog_categories;
DROP FUNCTION bump_catalog_revision();
DROP TABLE catalog_revision;
DROP TABLE catalog_synonyms;
DROP TABLE catalog_product_images;
DROP TABLE media_orphan_objects;
DROP TABLE catalog_media;
DROP TABLE catalog_prices;
DROP VIEW inventory_saleable_availability;
DROP TABLE store_inventory;
DROP TABLE catalog_variants;
DROP TABLE catalog_publication_history;
DROP TABLE catalog_products;
DROP TABLE catalog_brands;
DROP TABLE catalog_categories;
