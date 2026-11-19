-- Up Migration
-- Update only the ten explicitly seeded development SKUs. Keep prior prices as history.
DO $$
DECLARE item record; current_price record; effective_at timestamptz; next_price timestamptz;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('DD-TEST-001', 3900::bigint), ('DD-TEST-002', 3200::bigint),
    ('DD-TEST-003', 5500::bigint), ('DD-TEST-004', 4500::bigint),
    ('DD-TEST-005', 9500::bigint), ('DD-TEST-006', 6000::bigint),
    ('DD-TEST-007', 15000::bigint), ('DD-TEST-008', 2000::bigint),
    ('DD-TEST-009', 3000::bigint), ('DD-TEST-010', 4000::bigint)
  ) AS prices(sku, amount)
  LOOP
    SELECT cp.variant_id, cp.store_id, cp.created_by, cp.selling_paise
      INTO current_price FROM catalog_variants v
      JOIN catalog_prices cp ON cp.variant_id=v.id
      WHERE v.sku=item.sku AND cp.valid_from <= statement_timestamp()
        AND (cp.valid_to IS NULL OR cp.valid_to > statement_timestamp())
      ORDER BY cp.valid_from DESC, cp.created_at DESC, cp.id DESC LIMIT 1;
    IF current_price.variant_id IS NULL OR current_price.selling_paise=item.amount THEN CONTINUE; END IF;
    effective_at := clock_timestamp();
    SELECT min(valid_from) INTO next_price FROM catalog_prices
      WHERE store_id=current_price.store_id AND variant_id=current_price.variant_id AND valid_from>effective_at;
    UPDATE catalog_prices SET valid_to=effective_at
      WHERE store_id=current_price.store_id AND variant_id=current_price.variant_id
        AND valid_from<effective_at AND (valid_to IS NULL OR valid_to>effective_at);
    INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,valid_to,created_by)
      VALUES(gen_random_uuid(),current_price.store_id,current_price.variant_id,item.amount,item.amount,
        effective_at,next_price,current_price.created_by);
    INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
      VALUES(gen_random_uuid(),NULL,'INITIAL_SHARED_PRICE','catalog_variant',current_price.variant_id::text,
        jsonb_build_object('sku',item.sku,'oldPaise',current_price.selling_paise::text,'newPaise',item.amount::text));
  END LOOP;
END $$;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Catalog prices are a forward-only data correction'; END $$;
