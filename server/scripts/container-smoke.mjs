import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from 'pg';

const execute = promisify(execFile);
const image = process.env.P13_IMAGE ?? 'delivery-platform:p13';
const output = resolve(process.env.P13_ARTIFACT_DIR ?? 'artifacts/p13-container');
const prefix = `delivery-p13-smoke-${randomUUID().slice(0, 8)}`;
const network = `${prefix}-net`;
const pgName = `${prefix}-pg`;
const redisName = `${prefix}-redis`;
const catalogVolume = `${prefix}-catalog`;
const containers = [];
const temporary = await mkdtemp(join(tmpdir(), 'delivery-p13-container-'));
const results = [];
let networkCreated = false;
let volumeCreated = false;
await mkdir(output, { recursive: true });
await chmod(temporary, 0o755);
async function command(binary, args, env) {
  try {
    return (
      await execute(binary, args, {
        env: env ?? process.env,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    await writeFile(
      join(output, 'command-error.log'),
      detail.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL]'),
    );
    throw new Error(`Container smoke command failed: ${binary} ${args[0] ?? ''}`, { cause: error });
  }
}
const docker = (...args) => command('docker', args);
async function start(name, args) {
  await docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'delivery.task=p13-container-smoke',
    '--network',
    network,
    ...args,
  );
  containers.push(name);
}
async function eventually(work, description) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if (await work()) return;
    } catch {
      /* startup can race dependency readiness */
    }
    await pause(250);
  }
  throw new Error(`Container smoke timeout: ${description}`);
}
try {
  await docker('network', 'create', '--label', 'delivery.task=p13-container-smoke', network);
  networkCreated = true;
  await start(pgName, [
    '--network-alias',
    'postgres',
    '-e',
    'POSTGRES_USER=delivery',
    '-e',
    'POSTGRES_PASSWORD=delivery',
    '-e',
    'POSTGRES_DB=delivery',
    '-p',
    '127.0.0.1::5432',
    'postgis/postgis:16-3.6-alpine@sha256:d5955943c6e633219d80bd1d7fd986a097fdd44f3979c53d4839d62647bba478',
  ]);
  await start(redisName, [
    '--network-alias',
    'redis',
    'redis:7.4.12-alpine3.21@sha256:338fbfc036dc5517ac0b04d6de21521085935336e565f223406180e9d84166e2',
  ]);
  await eventually(
    async () =>
      (
        await docker(
          'exec',
          pgName,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'delivery',
          '-d',
          'delivery',
        )
      ).includes('accepting connections'),
    'PostgreSQL',
  );
  const databaseUrl = 'postgresql://delivery:delivery@postgres:5432/delivery';
  const migrationLog = await docker(
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=64m',
    '-e',
    'NODE_ENV=test',
    '-e',
    `DATABASE_URL=${databaseUrl}`,
    image,
    'node',
    'scripts/migrate.ts',
  );
  await writeFile(join(output, 'migrations.log'), migrationLog + '\n');
  await docker(
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=64m',
    '-e',
    'NODE_ENV=test',
    '-e',
    `DATABASE_URL=${databaseUrl}`,
    image,
    'node',
    'scripts/migrate.ts',
  );
  const port = (await docker('port', pgName, '5432/tcp')).split(':').at(-1);
  const hostUrl = `postgresql://delivery:delivery@127.0.0.1:${port}/delivery`;
  const seedEnv = {
    ...process.env,
    DATABASE_URL: hostUrl,
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'local',
    LOCAL_CATALOG_STORAGE_DIR: join(temporary, 'catalog'),
  };
  await command(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], seedEnv);
  await command(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], seedEnv);
  await docker('volume', 'create', '--label', 'delivery.task=p13-container-smoke', catalogVolume);
  volumeCreated = true;
  const copier = `${prefix}-copy`;
  await docker('create', '--name', copier, '-v', `${catalogVolume}:/app/var/catalog`, image);
  containers.push(copier);
  await docker('cp', `${join(temporary, 'catalog')}/.`, `${copier}:/app/var/catalog`);
  const db = new Client({ connectionString: hostUrl });
  try {
    await db.connect();
    const count = await db.query(
      'SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM catalog_products) AS products,(SELECT sum(on_hand)::text FROM store_inventory) AS stock',
    );
    if (
      JSON.stringify(count.rows[0]) !== JSON.stringify({ users: 8, products: 200, stock: '4000' })
    )
      throw new Error('Seed replay changed fixture quantities');
  } finally {
    await db.end();
  }
  await docker(
    'exec',
    pgName,
    'pg_dump',
    '-U',
    'delivery',
    '-d',
    'delivery',
    '--file=/tmp/p13-backup.sql',
  );
  await docker('exec', pgName, 'createdb', '-U', 'delivery', 'delivery_restore');
  await docker(
    'exec',
    pgName,
    'psql',
    '-U',
    'delivery',
    '-d',
    'delivery_restore',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    '/tmp/p13-backup.sql',
  );
  const restored = new Client({
    connectionString: hostUrl.replace(/\/delivery$/, '/delivery_restore'),
  });
  try {
    await restored.connect();
    const check = await restored.query(
      'SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM catalog_products) AS products,(SELECT sum(on_hand)::text FROM store_inventory) AS stock,(SELECT sum(on_hand_delta)::text FROM inventory_ledger) AS ledger,(SELECT count(*)::int FROM pgmigrations) AS migrations',
    );
    const expectedMigrations = await docker(
      'exec',
      pgName,
      'psql',
      '-U',
      'delivery',
      '-d',
      'delivery',
      '-Atc',
      'SELECT count(*) FROM pgmigrations',
    );
    if (
      JSON.stringify(check.rows[0]) !==
      JSON.stringify({
        users: 8,
        products: 200,
        stock: '4000',
        ledger: '4000',
        migrations: Number(expectedMigrations),
      })
    )
      throw new Error('Restored seed/ledger/migration snapshot differs');
    await writeFile(
      join(output, 'restore.json'),
      JSON.stringify(
        {
          success: true,
          fixture: 'seeded local database',
          ...check.rows[0],
          privateObjectRestore: 'not exercised; shared named test volume retained for role smoke',
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await restored.end();
  }
  for (const role of ['customer', 'rider', 'store', 'admin', 'worker', 'all']) {
    const name = `${prefix}-${role}`;
    await start(name, [
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,size=128m,mode=1777',
      '--tmpfs',
      '/app/var:rw,size=64m,uid=1000,gid=1000',
      '-v',
      `${catalogVolume}:/app/var/catalog:ro`,
      '-e',
      'NODE_ENV=test',
      '-e',
      `APP_ROLE=${role}`,
      '-e',
      'LOG_LEVEL=warn',
      '-e',
      `DATABASE_URL=${databaseUrl}`,
      '-e',
      'REDIS_URL=redis://redis:6379',
      '-e',
      'LOCAL_PRIVATE_STORAGE_DIR=/app/var/private',
      '-e',
      'LOCAL_CATALOG_STORAGE_DIR=/app/var/catalog',
      '-p',
      '127.0.0.1::3000',
      image,
    ]);
    const appPort = (await docker('port', name, '3000/tcp')).split(':').at(-1);
    const origin = `http://127.0.0.1:${appPort}`;
    await eventually(
      async () => (await globalThis.fetch(`${origin}/readyz`)).status === 200,
      `${role} readiness`,
    );
    const user = await docker('exec', name, 'id', '-u');
    if (user === '0') throw new Error('Container runs as root');
    if ((await globalThis.fetch(`${origin}/healthz`)).status !== 200)
      throw new Error('Liveness failed');
    for (const surface of ['customer', 'rider', 'store', 'admin']) {
      const response = await globalThis.fetch(`${origin}/v1/${surface}/me`);
      const expected = role === 'all' || role === surface ? (surface === 'admin' ? 404 : 401) : 404;
      if (response.status !== expected)
        throw new Error(`${role} audience isolation failed for ${surface}`);
    }
    const inspect = JSON.parse(await docker('inspect', name))[0];
    if (!inspect.HostConfig.ReadonlyRootfs || inspect.Config.User !== 'node')
      throw new Error('Container filesystem/user policy failed');
    await docker('kill', '--signal', 'SIGTERM', name);
    const exit = await docker('wait', name);
    const logs = await docker('logs', name);
    await writeFile(join(output, `${role}.log`), logs + '\n');
    if (exit !== '0') throw new Error(`${role} shutdown failed`);
    results.push({
      role,
      ready: true,
      nonRoot: true,
      readOnly: true,
      isolation: true,
      exitCode: 0,
    });
    process.stdout.write(`${role}: readiness, isolation, non-root/read-only and shutdown passed\n`);
  }
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ success: true, image, results }, null, 2) + '\n',
  );
} catch (error) {
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        success: false,
        image,
        results,
        error: error instanceof Error ? error.message : 'Container smoke failed',
      },
      null,
      2,
    ) + '\n',
  );
  for (const name of containers) {
    try {
      await writeFile(join(output, `${name}.failure.log`), await docker('logs', name));
    } catch {
      /* retain other evidence */
    }
  }
  process.exitCode = 1;
  process.stderr.write((error instanceof Error ? error.message : 'Container smoke failed') + '\n');
} finally {
  for (const name of containers.reverse()) {
    try {
      await docker('rm', '-f', name);
    } catch {
      /* already removed */
    }
  }
  if (networkCreated) {
    try {
      await docker('network', 'rm', network);
    } catch {
      /* preserve original error */
    }
  }
  if (volumeCreated) {
    try {
      await docker('volume', 'rm', catalogVolume);
    } catch {
      /* preserve original error */
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
