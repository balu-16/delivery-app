import { existsSync } from 'node:fs';

// Production/container installs have neither Git metadata nor dev dependencies.
if (process.env.HUSKY !== '0' && process.env.NODE_ENV !== 'production' && existsSync('../.git')) {
  const { default: installHooks } = await import('husky');
  process.chdir('..');
  const message = installHooks();
  if (message) process.stderr.write(`${message}\n`);
}
