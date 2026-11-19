-- Up Migration
ALTER TABLE agent_cart_choices ADD COLUMN selection jsonb;

-- Down Migration
ALTER TABLE agent_cart_choices DROP COLUMN selection;
