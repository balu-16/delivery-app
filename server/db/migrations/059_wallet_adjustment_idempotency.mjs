// An adjustment request ID belongs to one admin and one operation forever.
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname='wallet_adjustment_request_key_idx' AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid wallet adjustment index before retrying migration 059'; END IF;
  END $$`);
  pgm.sql(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS wallet_adjustment_request_key_idx
    ON maker_checker_requests(maker_id, (payload->>'clientRequestId'))
    WHERE action='walletAdjustment' AND payload ? 'clientRequestId'`);
}
export const down = false;
