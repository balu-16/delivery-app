import * as SQLite from 'expo-sqlite';

// A write transaction is a process-wide lock. The database holds no tokens;
// the refresh token itself remains in SecureStore.
let database: Promise<SQLite.SQLiteDatabase> | undefined;
export async function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  database ??= SQLite.openDatabaseAsync('dairydirect-session-lock.db').catch((error: unknown) => { database = undefined; throw error; });
  const db = await database;
  for (let attempt = 0; attempt < 160; attempt++) {
    let entered = false;
    let result!: T;
    try {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.execAsync('CREATE TABLE IF NOT EXISTS session_lock (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO session_lock(id,value) VALUES (1,0); UPDATE session_lock SET value=value WHERE id=1;');
        entered = true;
        result = await work();
      });
      return result;
    } catch (error) {
      if (entered || !(error instanceof Error) || !/locked|busy/i.test(error.message) || attempt === 159) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('Could not obtain the session lock.');
}
