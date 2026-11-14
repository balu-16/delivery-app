import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { postgresConnectionConfig } from '../src/platform/database/database.js';

async function main() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.DATABASE_AUTH !== 'iam' ||
    process.env.AWS_P13_ISOLATED_DATABASE !== 'yes'
  )
    throw new Error(
      'A development IAM configuration and AWS_P13_ISOLATED_DATABASE=yes are required',
    );
  const region = process.env.AWS_REGION;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!region || !ownerUrl || !runtimeUrl) throw new Error('Missing database configuration');
  const owner = new URL(ownerUrl);
  const runtime = new URL(runtimeUrl);
  if (
    owner.hostname !== runtime.hostname ||
    owner.port !== runtime.port ||
    owner.pathname !== '/deliveryapp'
  )
    throw new Error('Owner and development database endpoints must match');
  const name = `delivery_p13_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({
    ...postgresConnectionConfig(ownerUrl, region),
    max: 1,
    connectionTimeoutMillis: 30000,
  });
  let created = false;
  let test: Pool | undefined;
  try {
    const identity = await admin.query<{ db: string; can_create: boolean }>(
      'SELECT current_database() AS db, (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS can_create',
    );
    if (identity.rows[0]?.db !== 'deliveryapp' || !identity.rows[0]?.can_create)
      throw new Error('Development database owner must have CREATE DATABASE');
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    owner.pathname = `/${name}`;
    const testUrl = owner.toString();
    const config = postgresConnectionConfig(testUrl, region);
    await runner({
      databaseUrl: config,
      dir: resolve('db/migrations'),
      migrationsTable: 'pgmigrations',
      direction: 'up',
      count: Infinity,
      log: () => undefined,
    });
    test = new Pool({ ...config, max: 1, connectionTimeoutMillis: 30000 });
    const expected = (await readdir('db/migrations'))
      .filter((name) => /\.(sql|mjs)$/.test(name))
      .map((name) => name.replace(/\.(sql|mjs)$/, ''))
      .sort();
    const version = await test.query<{ name: string }>(
      'SELECT name FROM pgmigrations ORDER BY name',
    );
    assert.deepEqual(
      version.rows.map((row) => row.name),
      expected,
    );
    const extensions = await test.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('postgis','pg_trgm','pgcrypto','btree_gist') ORDER BY extname",
    );
    assert.deepEqual(
      extensions.rows.map((row) => row.extname),
      ['btree_gist', 'pg_trgm', 'pgcrypto', 'postgis'],
    );
    const point = await test.query<{ ok: boolean }>(
      "SELECT ST_Covers(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326),ST_SetSRID(ST_MakePoint(0,0),4326)) AS ok",
    );
    assert.equal(point.rows[0]?.ok, true);
    await runner({
      databaseUrl: config,
      dir: resolve('db/migrations'),
      migrationsTable: 'pgmigrations',
      direction: 'up',
      count: Infinity,
      log: () => undefined,
    });
    const repeat = await test.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pgmigrations',
    );
    assert.equal(Number(repeat.rows[0]?.count), expected.length);
    console.log(
      `Aurora ${expected.length} clean migrations, PostGIS boundary and migration replay passed`,
    );
  } finally {
    let cleanupFailed = false;
    try {
      await test?.end();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        console.log('Temporary Aurora migration database removed');
      }
    } finally {
      await admin.end();
    }
    if (cleanupFailed) {
      console.error('A test connection could not be closed cleanly');
      process.exitCode = 1;
    }
  }
}
void main().catch((error: unknown) => {
  console.error(
    'Aurora migration P13 test failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
