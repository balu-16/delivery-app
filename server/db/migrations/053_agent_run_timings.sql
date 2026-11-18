-- Up Migration
-- Separate timing for assistant runs. No message text or customer details.
ALTER TABLE agent_runs
  ADD COLUMN model_ms integer CHECK (model_ms IS NULL OR model_ms >= 0),
  ADD COLUMN tool_ms integer CHECK (tool_ms IS NULL OR tool_ms >= 0),
  ADD COLUMN db_ms integer CHECK (db_ms IS NULL OR db_ms >= 0);

-- Down Migration
ALTER TABLE agent_runs DROP COLUMN db_ms, DROP COLUMN tool_ms, DROP COLUMN model_ms;
