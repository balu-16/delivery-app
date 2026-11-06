import { existsSync } from 'node:fs';
import { createApplication } from './bootstrap.js';
import { readEnv } from './config/env.schema.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = readEnv(process.env);
  const app = await createApplication(env);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      process.exitCode = 1;
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    void app.close().then(
      () => clearTimeout(timer),
      () => {
        clearTimeout(timer);
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await app.listen(env.PORT, '0.0.0.0');
}

void main().catch((error: unknown) => {
  // Environment errors report key names, never values; unexpected errors are not printed.
  process.stderr.write(
    error instanceof Error && error.message.startsWith('Invalid environment:')
      ? `${error.message}\n`
      : 'Application startup failed\n',
  );
  process.exitCode = 1;
});
