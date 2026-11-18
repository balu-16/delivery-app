-- Up Migration
-- Rename only the explicitly seeded development SKUs, preserving their IDs and stock.
WITH names(sku, old_name, new_name) AS (VALUES
  ('DD-TEST-001','Test full-cream milk','Full-cream milk'),
  ('DD-TEST-002','Test toned milk','Toned milk'),
  ('DD-TEST-003','Test A2 milk','A2 milk'),
  ('DD-TEST-004','Test curd','Curd'),
  ('DD-TEST-005','Test paneer','Paneer'),
  ('DD-TEST-006','Test butter','Butter'),
  ('DD-TEST-007','Test ghee','Ghee'),
  ('DD-TEST-008','Test buttermilk','Buttermilk'),
  ('DD-TEST-009','Test sweet lassi','Sweet lassi'),
  ('DD-TEST-010','Test yogurt','Yogurt')
)
UPDATE catalog_products p SET name=n.new_name, normalized_name=lower(n.new_name),
  description=CASE WHEN p.description='Test product for app checkout. Image is illustrative.' THEN 'Fresh dairy product. Image is illustrative.' ELSE p.description END,
  updated_at=clock_timestamp()
FROM names n JOIN catalog_variants v ON v.sku=n.sku AND v.deleted_at IS NULL
WHERE p.id=v.product_id AND p.name=n.old_name AND p.deleted_at IS NULL;

UPDATE catalog_categories c SET name='Dairy', updated_at=clock_timestamp()
WHERE c.name='Test Dairy' AND c.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM catalog_products p JOIN catalog_variants v ON v.product_id=p.id
  WHERE p.category_id=c.id AND v.sku IN ('DD-TEST-001','DD-TEST-002','DD-TEST-003','DD-TEST-004','DD-TEST-005','DD-TEST-006','DD-TEST-007','DD-TEST-008','DD-TEST-009','DD-TEST-010')
);

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Catalog names are a forward-only data correction'; END $$;
