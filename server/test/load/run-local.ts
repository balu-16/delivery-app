import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import { Client } from 'pg';
import { startTestServices, type TestServices } from '../helpers/services.js';

// Explicit modes prevent a short CI wiring check masquerading as acceptance.
async function main() {
  const argument = process.argv[2];
  if (argument !== '--profile=smoke' && argument !== '--profile=local')
    throw new Error('Usage: node --import tsx test/load/run-local.ts --profile=smoke|local');
  const profile = argument.slice('--profile='.length),
    mode = profile,
    out = resolve(process.env.LOAD_OUTPUT_DIR ?? `artifacts/p13-run-${mode}-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const report: Record<string, unknown> = {
    mode,
    profile,
    loadFixtureSettings: {
      storeBacklogPauseThreshold: 20000,
      rateLimitDefaultPerMinute: 10000,
      rateLimitSearchPerMinute: 10000,
      rateLimitLocationPerMinute: 10000,
    },
    startedAt: new Date().toISOString(),
    host: {
      cpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      platform: os.platform(),
      arch: os.arch(),
    },
    steps: [],
    exitCode: 1,
  };
  const steps = report.steps as { name: string; exitCode: number | null }[],
    children: ChildProcess[] = [];
  let services: TestServices | undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'local',
    LOCAL_JWT_SECRET: 'p13-local-load-secret-only',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_DEFAULT_PER_MIN: '10000',
    RATE_LIMIT_SEARCH_PER_MIN: '10000',
    RATE_LIMIT_LOCATION_PER_MIN: '10000',
    LOAD_OUTPUT_DIR: out,
    LOAD_PROFILE: profile,
    LOAD_FIXTURES: 'yes',
    LOCAL_CATALOG_STORAGE_DIR: `${out}/catalog-storage`,
  };
  delete process.env.TEST_DATABASE_URL;
  delete process.env.TEST_REDIS_URL; // Always isolated containers, never an ambient shared Redis.
  const run = async (
    name: string,
    command: string,
    args: string[],
    extra: NodeJS.ProcessEnv = {},
  ) => {
    const log = createWriteStream(`${out}/${name}.log`),
      started = Date.now();
    const child = spawn(command, args, {
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
    const code = await new Promise<number | null>((res, rej) => {
      child.once('error', rej);
      child.once('exit', res);
    });
    steps.push({ name, exitCode: code });
    if (code !== 0) throw new Error(`${name} failed (${code})`);
    return Date.now() - started;
  };
  const port = async () =>
    new Promise<number>((res, rej) => {
      const server = createServer();
      server.once('error', rej);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string')
          return rej(new Error('port allocation failed'));
        server.close(() => res(address.port));
      });
    });
  const launch = async (name: string, role: string) => {
    const n = await port(),
      log = createWriteStream(`${out}/${name}.log`);
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: { ...env, APP_ROLE: role, PORT: String(n) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
    const url = `http://127.0.0.1:${n}`,
      deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${name} exited during startup`);
      try {
        const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return url;
      } catch {
        /* Retry until ready. */
      }
      await delay(250);
    }
    throw new Error(`${name} readiness timeout`);
  };
  try {
    if (!existsSync('artifacts/load-tools/k6-v1.3.0'))
      await run('install-k6', 'bash', ['test/load/install-k6.sh']);
    services = await startTestServices();
    env.DATABASE_URL = services.databaseUrl;
    env.REDIS_URL = services.redisUrl;
    const node = process.execPath,
      fixture = `${out}/fixtures.json`;
    env.LOAD_FIXTURE_FILE = fixture;
    await run('build', node, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
    await run('migrate', node, ['--import', 'tsx', 'scripts/migrate.ts']);
    await run('outbox', node, ['--import', 'tsx', 'test/load/outbox.ts'], {
      LOAD_ISOLATED_DATABASE: 'yes',
    });
    await run('seed', node, ['--import', 'tsx', 'scripts/seed.ts']);
    await run('fixtures', node, ['--import', 'tsx', 'test/load/fixtures.ts']);
    const data = JSON.parse(await readFile(fixture, 'utf8')) as {
      customers: { token: string; addressId: string }[];
    };
    const customer = await launch('customer', 'customer'),
      rider1 = await launch('rider1', 'rider'),
      rider2 = await launch('rider2', 'rider');
    await launch('worker', 'worker');
    await run('catalog', 'bash', ['test/load/run-catalog.sh'], {
      BASE_URL: customer,
      CUSTOMER_TOKEN: data.customers[1299]!.token,
      ADDRESS_ID: data.customers[1299]!.addressId,
    });
    await run('checkout-distributed', 'bash', ['test/load/run-http.sh'], {
      BASE_URL: customer,
      LOAD_KIND: 'checkout',
      CHECKOUT_MODE: 'distributed',
      CHECKOUT_OFFSET: '0',
    });
    await run('checkout-hot', 'bash', ['test/load/run-http.sh'], {
      BASE_URL: customer,
      LOAD_KIND: 'checkout',
      CHECKOUT_MODE: 'hot',
      CHECKOUT_OFFSET: mode === 'smoke' ? '10' : '620',
    });
    await run('gps', 'bash', ['test/load/run-http.sh'], { BASE_URL: rider1, LOAD_KIND: 'gps' });
    await run('sockets', node, ['test/load/sockets.mjs'], {
      RIDER_URL_1: rider1,
      RIDER_URL_2: rider2,
    });
    // The 10k distributed test has its own isolated test services; run separately after this orchestrator.
    report.subscription10k = 'not run; execute p13-distributed-load separately';
    report.exitCode = 0;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          await Promise.race([new Promise((r) => child.once('exit', r)), delay(20000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }),
    );
    if (services) {
      try {
        const client = new Client({ connectionString: services!.databaseUrl });
        await client.connect();
        try {
          const result = await client.query(
            `SELECT (SELECT count(*)::int FROM wallet_accounts a WHERE a.cash_balance_paise <> COALESCE((SELECT sum(delta_paise) FROM wallet_ledger l WHERE l.account_id=a.id AND l.bucket='cash'),0) OR a.promo_balance_paise <> COALESCE((SELECT sum(delta_paise) FROM wallet_ledger l WHERE l.account_id=a.id AND l.bucket='promo'),0)) AS wallet, (SELECT count(*)::int FROM store_inventory i WHERE i.on_hand <> COALESCE((SELECT sum(on_hand_delta) FROM inventory_ledger l WHERE l.store_id=i.store_id AND l.variant_id=i.variant_id),0) OR i.reserved <> COALESCE((SELECT sum(reserved_delta) FROM inventory_ledger l WHERE l.store_id=i.store_id AND l.variant_id=i.variant_id),0)) AS inventory`,
          );
          report.invariants = result.rows[0];
          if (result.rows[0].wallet || result.rows[0].inventory) {
            report.invariantError = 'Ledger invariant violation';
            report.exitCode = 1;
          }
        } finally {
          await client.end();
        }
      } catch (error) {
        report.invariantError = String(error);
        report.exitCode = 1;
      }
    }
    try {
      await services?.stop();
    } catch (error) {
      report.cleanupError = String(error);
      report.exitCode = 1;
    }
    report.endedAt = new Date().toISOString();
    await writeFile(`${out}/run.json`, JSON.stringify(report, null, 2));
    console.log(`Report: ${out}/run.json`);
    process.exitCode = Number(report.exitCode);
  }
}
void main();
