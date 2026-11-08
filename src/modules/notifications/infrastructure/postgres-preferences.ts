import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type {
  NotificationCategory,
  NotificationPreferences,
  PreferenceView,
} from '../contracts/notifications.js';

const UUID = /^[0-9a-f-]{36}$/i;
export const ALL_CATEGORIES: readonly NotificationCategory[] = [
  'ORDER_UPDATES',
  'PAYMENTS',
  'WALLET',
  'RIDING',
  'STORE_OPS',
  'ADMIN',
  'PROMOTIONS',
];

/** Opt-out model: missing rows mean enabled; updates upsert category rows. */
export class PostgresNotificationPreferences implements NotificationPreferences {
  constructor(private readonly db: Database) {}

  async get(userId: string): Promise<PreferenceView[]> {
    if (!UUID.test(userId)) throw new Error('INVALID_INPUT');
    const rows = await sql<{
      category: NotificationCategory;
      enabled: boolean;
    }>`SELECT category,enabled FROM notification_preferences WHERE user_id=${userId}::uuid`.execute(
      this.db,
    );
    const stored = new Map(rows.rows.map((row) => [row.category, row.enabled]));
    return ALL_CATEGORIES.map((category) => ({
      category,
      enabled: stored.get(category) ?? true,
    }));
  }

  async set(
    userId: string,
    updates: { category: NotificationCategory; enabled: boolean }[],
  ): Promise<void> {
    if (!UUID.test(userId)) throw new Error('INVALID_INPUT');
    if (!updates.length) return;
    for (const update of updates)
      await sql`INSERT INTO notification_preferences(user_id,category,enabled) VALUES (${userId}::uuid,${update.category},${update.enabled})
        ON CONFLICT (user_id,category) DO UPDATE SET enabled=excluded.enabled,updated_at=clock_timestamp()`.execute(
        this.db,
      );
  }
}
