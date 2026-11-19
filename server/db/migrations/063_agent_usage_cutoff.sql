-- Up Migration
-- Account-scoped agent token cutoff. A development reset sets the cutoff to
-- now so reset runs no longer count toward the daily token budget; the
-- cutoff naturally expires at the next midnight IST (Asia/Kolkata), while
-- run history and turns already used remain available.
CREATE TABLE agent_usage_cutoffs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_cutoff_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Down Migration
DROP TABLE agent_usage_cutoffs;
