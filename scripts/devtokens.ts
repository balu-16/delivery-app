import { createDatabase } from '../src/platform/database/database.js';
import { LocalTokenAdapter } from '../src/adapters/auth/local.js';
import type { Audience, Pool, TokenUse } from '../src/modules/identity/contracts/identity.js';
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' || process.env.AUTH_PROVIDER === 'cognito')
    throw new Error('Development tokens are unavailable for this provider');
  const [pool, sub, audience, tokenUse] = process.argv.slice(2);
  if (
    !['CUSTOMER', 'WORKFORCE'].includes(pool ?? '') ||
    !sub ||
    !['customer', 'rider', 'store', 'admin'].includes(audience ?? '') ||
    !['id', 'access'].includes(tokenUse ?? '')
  )
    throw new Error(
      'Usage: devtokens CUSTOMER|WORKFORCE <sub> customer|rider|store|admin id|access',
    );
  const url = process.env.DATABASE_URL,
    secret = process.env.LOCAL_JWT_SECRET;
  if (!url || !secret) throw new Error('DATABASE_URL and LOCAL_JWT_SECRET are required');
  const db = createDatabase(url);
  try {
    process.stdout.write(
      `${await new LocalTokenAdapter(secret, db.db).issue(pool as Pool, sub, audience as Audience, tokenUse as TokenUse)}\n`,
    );
  } finally {
    await db.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
