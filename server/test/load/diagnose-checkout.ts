import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { startTestServices } from '../helpers/services.js';

// A short, explicitly named diagnostic, not a P13 acceptance profile.
async function main() {
  delete process.env.TEST_DATABASE_URL;
  delete process.env.TEST_REDIS_URL;
  const output = `artifacts/p13-checkout-diagnostic-${Date.now()}`;
  await mkdir(output, { recursive: true });
  const services = await startTestServices(),
    children: ChildProcess[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'local',
    LOCAL_JWT_SECRET: 'p13-local-load-secret-only',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    RATE_LIMIT_DEFAULT_PER_MIN: '10000',
    LOG_LEVEL: 'silent',
    LOAD_FIXTURES: 'yes',
    LOAD_FIXTURE_FILE: `${process.cwd()}/${output}/fixtures.json`,
    LOAD_OUTPUT_DIR: output,
    LOCAL_CATALOG_STORAGE_DIR: `${process.cwd()}/${output}/catalog`,
    LOAD_PROFILE: 'diagnostic',
    LOAD_KIND: 'checkout',
    CHECKOUT_MODE: 'distributed',
    BASE_URL: 'http://127.0.0.1:48125',
  };
  const run = async (
    name: string,
    executable: string,
    args: string[],
    extra: NodeJS.ProcessEnv = {},
  ) => {
    const log = createWriteStream(`${output}/${name}.log`),
      child = spawn(executable, args, {
        env: { ...env, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    children.push(child);
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
    return await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  };
  const client = new Client({ connectionString: services.databaseUrl });
  const app = (role: string, port: string) => {
    const log = createWriteStream(`${output}/${role}.log`),
      child = spawn(process.execPath, ['dist/main.js'], {
        env: { ...env, APP_ROLE: role, PORT: port },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    children.push(child);
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
  };
  let result: Record<string, unknown> = {};
  try {
    for (const [name, args] of [
      ['migrate', ['--import', 'tsx', 'scripts/migrate.ts']],
      ['seed', ['--import', 'tsx', 'scripts/seed.ts']],
      ['fixtures', ['--import', 'tsx', 'test/load/fixtures.ts']],
    ] as const)
      if (await run(name, process.execPath, [...args])) throw new Error(`${name} failed`);
    await client.connect();
    await client.query(
      "UPDATE app_config SET value='100'::jsonb,version=version+1 WHERE key='storeBacklogPauseThreshold'",
    );
    app('customer', '48125');
    app('worker', '50563');
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        const response = await fetch('http://127.0.0.1:48125/readyz');
        if (response.ok) break;
      } catch {
        // Wait until the listener is ready.
      }
      if (Date.now() > deadline) throw new Error('startup timed out');
      await delay(250);
    }
    const first = await run('default-threshold', 'bash', ['test/load/run-http.sh'], {
      CHECKOUT_OFFSET: '0',
    });
    // The picking maintenance worker runs once per minute.
    await delay(65000);
    const before = (
      await client.query(
        "SELECT status,pause_reason,(SELECT pick_backlog FROM store_operational_signals WHERE store_id=s.id) AS backlog FROM stores s WHERE id='01800000-0000-7000-8000-000000000011'",
      )
    ).rows[0];
    await client.query(
      "UPDATE app_config SET value='20000'::jsonb,version=version+1 WHERE key='storeBacklogPauseThreshold'",
    );
    await client.query(
      "UPDATE stores SET status='ONLINE',pause_reason=NULL WHERE id='01800000-0000-7000-8000-000000000011'",
    );
    const second = await run('raised-threshold', 'bash', ['test/load/run-http.sh'], {
      CHECKOUT_OFFSET: '200',
    });
    await delay(65000);
    const after = (
      await client.query(
        "SELECT status,pause_reason,(SELECT pick_backlog FROM store_operational_signals WHERE store_id=s.id) AS backlog FROM stores s WHERE id='01800000-0000-7000-8000-000000000011'",
      )
    ).rows[0];
    result = {
      firstExit: first,
      before,
      secondExit: second,
      after,
      note: 'diagnostic 10/s 15s per phase, waiting 65s for picking maintenance after each; isolated local DB, default then 20000 threshold; all failures retained',
    };
  } catch (error) {
    result.error = String(error);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(20000)]);
      }),
    );
    await client.end().catch(() => undefined);
    await services.stop();
    await writeFile(`${output}/diagnosis.json`, JSON.stringify(result, null, 2));
    console.log(`${output}/diagnosis.json`);
    const before = result.before as { status?: string; pause_reason?: string } | undefined;
    const after = result.after as { status?: string } | undefined;
    process.exitCode =
      before?.status === 'PAUSED' &&
      before.pause_reason === 'AUTO_PICK_BACKLOG' &&
      result.secondExit === 0 &&
      after?.status === 'ONLINE'
        ? 0
        : 1;
  }
}
void main();
