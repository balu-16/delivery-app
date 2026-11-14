import { sql } from 'kysely';
import { createDatabase } from '../src/platform/database/database.js';
import { hashLocalPassword } from '../src/adapters/auth/local-admin-auth.js';

const USAGE = `Usage:
  node --env-file-if-exists=.env --import tsx scripts/set-local-admin-password.ts <email> <newPassword>

Updates the scrypt password hash of an existing WORKFORCE local_identity_directory
user (local development only, AUTH_PROVIDER=local). The password must be at least
12 characters and contain a letter and a digit. Create or repair the directory
user with pnpm seed first.`;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Local admin passwords are managed by the identity provider in production');
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    process.stderr.write(
      'Password must be at least 12 characters and contain a letter and a digit\n',
    );
    process.exitCode = 1;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDatabase(url);
  try {
    const normalized = email.trim().toLowerCase();
    const result = await sql<{ username: string }>`UPDATE local_identity_directory
      SET password_hash=${await hashLocalPassword(password)}
      WHERE pool='WORKFORCE' AND email=${normalized} RETURNING username`.execute(db.db);
    if (!result.rows.length) {
      process.stderr.write(`No WORKFORCE local directory user for ${normalized}. ${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Password updated for ${result.rows[0]!.username} (${normalized})\n`);
  } finally {
    await db.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
