import { Client } from 'pg';
import { databaseIamRegion, postgresConnectionConfig } from '../src/platform/database/database.js';

/** Run after migrations as the schema owner. The login role is provisioned separately. */
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  const role = process.env.RUNTIME_DATABASE_ROLE;
  if (!url || !role || !/^[a-z_][a-z0-9_]{0,62}$/.test(role))
    throw new Error('MIGRATION_DATABASE_URL and a valid RUNTIME_DATABASE_ROLE are required');
  const client = new Client({
    ...postgresConnectionConfig(url, databaseIamRegion(process.env)),
    connectionTimeoutMillis: 60000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query<{ ok: boolean }>(
      `SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AS ok FROM pg_roles WHERE rolname=$1`,
      [role],
    );
    if (!check.rows[0]?.ok)
      throw new Error('Runtime role must already exist without elevated attributes');
    const authority = await client.query<{ unsafe: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member = r.oid AND parent.rolname <> 'rds_iam') OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relowner=r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND n.nspowner=r.oid) AS unsafe FROM pg_roles r WHERE r.rolname=$1`,
      [role],
    );
    if (authority.rows[0]?.unsafe)
      throw new Error('Runtime role must not be a role member or own application objects');
    // The role identifier is restricted above; quote it regardless.
    const quoted = `"${role}"`;
    const database = await client.query<{ name: string }>('SELECT current_database() AS name');
    const dbName = `"${database.rows[0]!.name.replaceAll('"', '""')}"`;
    await client.query(`REVOKE TEMPORARY ON DATABASE ${dbName} FROM PUBLIC, ${quoted}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${quoted}`);
    await client.query(`REVOKE CREATE ON DATABASE ${dbName} FROM ${quoted}`);
    const residual = await client.query<{ unsafe: boolean }>(
      `SELECT
      has_database_privilege($1, current_database(), 'CREATE') OR
      EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND has_schema_privilege($1, n.oid, 'CREATE')) OR
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname=$1) OR
      EXISTS (SELECT 1 FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE r.rolname=$1) AS unsafe`,
      [role],
    );
    if (residual.rows[0]?.unsafe)
      throw new Error('Runtime role retains database/schema CREATE or owns functions/types');
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${quoted}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${quoted}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
    // Extension relations (for example PostGIS spatial_ref_sys) are not application data.
    const relations = await client.query<{
      name: string;
      kind: string;
    }>(`SELECT c.relname AS name,c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S') AND c.relname <> 'pgmigrations'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e')`);
    for (const { name, kind } of relations.rows) {
      const object = `public."${name.replaceAll('"', '""')}"`;
      if (kind === 'S')
        await client.query(`GRANT USAGE, SELECT ON SEQUENCE ${object} TO ${quoted}`);
      else await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${object} TO ${quoted}`);
    }
    // Delete is granted only to tables with an application cleanup path.
    const deletable = [
      'cart_items',
      'carts',
      'customer_favorites',
      'catalog_import_rows',
      'catalog_media',
      'catalog_synonyms',
      'cities',
      'compliance_export_objects',
      'device_tokens',
      'inventory_allocations',
      'inventory_reservations',
      'legal_entities',
      'local_identity_directory',
      'local_identity_groups',
      'media_orphan_objects',
      'notification_preferences',
      'notification_token_results',
      'pick_item_batches',
      'privacy_media_cleanup_objects',
      'private_media',
      'referral_codes',
      'rider_location_history',
      'store_capacity_claims',
      'store_holiday_hours',
      'store_holidays',
      'store_hours',
      'store_staff',
      'stores',
      'subscription_holidays',
      'subscription_pauses',
      'subscription_skips',
      'user_roles',
      'admin_sessions',
    ];
    await client.query(`REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM ${quoted}`);
    for (const table of deletable)
      await client.query(`GRANT DELETE ON TABLE public."${table}" TO ${quoted}`);
    await client.query(`REVOKE ALL ON TABLE public.pgmigrations FROM ${quoted}`);
    const immutable = await client.query<{ name: string }>(
      `SELECT DISTINCT c.relname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgname LIKE '%immutable' OR t.tgname LIKE '%append_only')`,
    );
    for (const { name } of immutable.rows) {
      // Conditional lifecycle tables retain UPDATE; their triggers enforce the narrower transition.
      const privileges = ['wallet_promo_lots', 'invoice_documents'].includes(name)
        ? 'DELETE'
        : 'UPDATE, DELETE';
      await client.query(
        `REVOKE ${privileges} ON TABLE public."${name.replaceAll('"', '""')}" FROM ${quoted}`,
      );
    }
    for (const name of [
      'ensure_location_partition',
      'ensure_location_partitions',
      'drop_location_partition',
    ])
      await client.query(`GRANT EXECUTE ON FUNCTION public.${name}(date) TO ${quoted}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
