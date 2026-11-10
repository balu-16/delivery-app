import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { startTestServices } from '../helpers/services.js';

const exec = promisify(execFile);
it('keeps request credentials and personal canaries out of real process logs during failures', async () => {
  const services = await startTestServices();
  const directory = await mkdtemp(resolve('.p13-process-privacy-'));
  const db = new Client({ connectionString: services.databaseUrl });
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  try {
    await runner({
      databaseUrl: services.databaseUrl,
      dir: resolve('db/migrations'),
      migrationsTable: 'pgmigrations',
      direction: 'up',
      log: () => undefined,
    });
    await db.connect();
    const user = uuidV7();
    await db.query(
      "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER','privacy-process','privacy-process@test.invalid','Customer',true)",
      [user],
    );
    await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER')", [user]);
    await db.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [user]);
    await exec(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '-p',
        resolve('tsconfig.build.json'),
        '--outDir',
        join(directory, 'dist'),
      ],
      { timeout: 60000 },
    );
    const portServer = createServer();
    await new Promise<void>((resolveListen) => portServer.listen(0, '127.0.0.1', resolveListen));
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const port = address.port;
    await new Promise<void>((resolveClose) => portServer.close(() => resolveClose()));
    const secret = 'privacy-process-test-secret';
    child = spawn(process.execPath, [join(directory, 'dist/main.js')], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        APP_ROLE: 'customer',
        LOG_LEVEL: 'info',
        PORT: String(port),
        AUTH_PROVIDER: 'local',
        LOCAL_JWT_SECRET: secret,
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        LOCAL_PRIVATE_STORAGE_DIR: directory,
        LOCAL_CATALOG_STORAGE_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`child exited: ${output}`);
      try {
        if ((await fetch(`${base}/healthz`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    expect(ready).toBe(true);
    const token = await new SignJWT({ token_use: 'access', 'cognito:groups': ['CUSTOMER'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('local:CUSTOMER')
      .setAudience('customer')
      .setSubject('privacy-process')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    const canaries = [
      'authorization-canary',
      'cookie-canary',
      'api-key-canary',
      'body-canary',
      'query-canary',
      token,
    ];
    const invalid = await fetch(`${base}/v1/customer/me?private=query-canary`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        cookie: 'session=cookie-canary',
        'x-api-key': 'api-key-canary',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'body-canary', unknown: true }),
    });
    expect(invalid.status).toBe(400);
    const unauthorized = await fetch(`${base}/v1/customer/me?private=query-canary`, {
      headers: {
        authorization: 'Bearer authorization-canary',
        cookie: 'session=cookie-canary',
        'x-api-key': 'api-key-canary',
      },
    });
    expect(unauthorized.status).toBe(401);
    // The isolated test database forces an unexpected server error after authorization.
    await db.query('ALTER TABLE customer_profiles RENAME TO customer_profiles_hidden_for_test');
    const failure = await fetch(`${base}/v1/customer/me?private=query-canary`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: 'session=cookie-canary',
        'x-api-key': 'api-key-canary',
        'x-request-id': 'privacy-trace-123',
      },
    });
    expect(failure.status).toBe(500);
    expect(failure.headers.get('x-request-id')).toBe('privacy-trace-123');
    expect(await failure.text()).not.toContain('query-canary');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(output).toContain('privacy-trace-123');
    for (const canary of canaries) expect(output).not.toContain(canary);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolveWait) => {
          const timeout = setTimeout(resolveWait, 10000);
          timeout.unref();
        }),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await db.end().catch(() => undefined);
    await services.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
