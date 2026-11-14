// Prevent concurrent enrollment from assigning more than one role or profile.
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname IN ('users_one_subject_idx','user_roles_one_role_idx') AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid role migration indexes before retrying migration 044'; END IF;
  END $$`);
  pgm.sql(
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_one_subject_idx ON users(cognito_sub)',
  );
  pgm.sql(
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_roles_one_role_idx ON user_roles(user_id)',
  );
}
export const down = false;
