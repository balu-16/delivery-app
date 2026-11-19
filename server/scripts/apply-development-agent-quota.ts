/**
 * Apply the plan3 assistant quota to the AWS development database only.
 *
 * - Sets the daily token budget to 150,000 and keeps the 20-turn cap.
 * - Zeroes today’s counted tokens for the development account that used
 *   64,469 tokens, via an account cutoff expiring at midnight IST.
 *
 * Guarded to NODE_ENV=development. Run after migration 063. Usage:
 *   node --env-file-if-exists=.env --import tsx scripts/apply-development-agent-quota.ts [--dry-run]
 */
import { createDatabase, databaseIamRegion } from '../src/platform/database/database.js';

// The restricted delivery-runtime session cannot write app_config; the owner
// identity (default credentials) is required for this one-time dev apply.
if (process.env.APPLY_QUOTA_WITH_ADMIN_IDENTITY === '1') {
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_CONFIG_FILE;
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
}

const TOKEN_BUDGET = 150000;
const TURN_LIMIT = 20;
const EXPECTED_TOKENS = 64469;

if (process.env.NODE_ENV !== 'development') {
  throw new Error('Refusing: this script targets the AWS development database only');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const dryRun = process.argv.includes('--dry-run');

const db = createDatabase(
  databaseUrl,
  2,
  20000,
  () => undefined,
  20000,
  databaseIamRegion(process.env),
);

async function main(): Promise<void> {
  const started = Date.now();
  // Read current quota directly.
  const rows = await (async () => {
    const { sql: s } = await import('kysely');
    return s<{
      key: string;
      value: unknown;
    }>`SELECT key, value FROM app_config WHERE key IN ('agent_daily_token_budget_per_user','agent_daily_turn_limit_per_user')`.execute(
      db.db,
    );
  })();
  console.log('Current quota rows:', JSON.stringify(rows.rows));

  const top = await (async () => {
    const { sql: s } = await import('kysely');
    return s<{
      user_id: string;
      turns: string;
      tokens: string;
    }>`SELECT user_id, count(*)::text AS turns, COALESCE(sum(input_tokens+output_tokens),0)::text AS tokens FROM agent_runs
      WHERE created_at >= ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata')
      GROUP BY user_id ORDER BY 3 DESC LIMIT 5`.execute(db.db);
  })();
  console.log('Today’s runs (IST):', JSON.stringify(top.rows));

  const affected = top.rows.find((row) => Number(row.tokens) === EXPECTED_TOKENS);
  if (!affected) {
    throw new Error(`Affected account with ${EXPECTED_TOKENS} tokens not found; nothing changed`);
  }
  console.log(
    `Affected development account: ${affected.user_id} turns=${affected.turns} tokens=${affected.tokens}`,
  );

  const hasCutoffTable = await (async () => {
    const { sql: s } = await import('kysely');
    const found = await s<{
      present: string | null;
    }>`SELECT to_regclass('agent_usage_cutoffs')::text AS present`.execute(db.db);
    return found.rows[0]?.present != null;
  })();
  if (!hasCutoffTable) throw new Error('agent_usage_cutoffs missing: run migration 063 first');

  if (dryRun) {
    console.log('Dry run: no changes applied.');
    return;
  }

  const { sql: s } = await import('kysely');
  await db.db.transaction().execute(async (tx) => {
    await s`INSERT INTO app_config(key,value,updated_by) VALUES ('agent_daily_token_budget_per_user',${JSON.stringify(TOKEN_BUDGET)}::jsonb,NULL)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, version=app_config.version+1, updated_at=clock_timestamp()`.execute(
      tx,
    );
    await s`INSERT INTO app_config(key,value,updated_by) VALUES ('agent_daily_turn_limit_per_user',${JSON.stringify(TURN_LIMIT)}::jsonb,NULL)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, version=app_config.version+1, updated_at=clock_timestamp()`.execute(
      tx,
    );
    await s`INSERT INTO agent_usage_cutoffs(user_id, token_cutoff_at, updated_at) VALUES (${affected.user_id}::uuid, clock_timestamp(), clock_timestamp())
      ON CONFLICT(user_id) DO UPDATE SET token_cutoff_at=EXCLUDED.token_cutoff_at, updated_at=clock_timestamp()`.execute(
      tx,
    );
  });
  console.log(
    `Applied in ${Date.now() - started}ms: budget=${TOKEN_BUDGET}, turns=${TURN_LIMIT}, cutoff set for ${affected.user_id}`,
  );

  const after = await (async () => {
    const { sql: s2 } = await import('kysely');
    return s2<{ turns: string; counted: string; budget: unknown }>`SELECT
      (SELECT count(*)::text FROM agent_runs WHERE user_id=${affected.user_id}::uuid AND created_at >= ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata')) AS turns,
      COALESCE((SELECT sum(input_tokens+output_tokens) FROM agent_runs WHERE user_id=${affected.user_id}::uuid AND created_at >= (SELECT token_cutoff_at FROM agent_usage_cutoffs WHERE user_id=${affected.user_id}::uuid)),0)::text AS counted,
      (SELECT value FROM app_config WHERE key='agent_daily_token_budget_per_user') AS budget`.execute(
      db.db,
    );
  })();
  console.log('After:', JSON.stringify(after.rows));
  if (Number(after.rows[0]?.counted ?? -1) !== 0)
    throw new Error('Counted tokens did not reset to zero');
  if (Number(after.rows[0]?.turns ?? 0) !== Number(affected.turns))
    throw new Error('Turns changed unexpectedly');
  console.log('Verified: counted tokens 0, turns preserved, budget applied.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
