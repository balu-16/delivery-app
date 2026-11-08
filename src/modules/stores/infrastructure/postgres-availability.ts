import { sql, type Kysely } from 'kysely';
import type { PlatformSchema, TransactionContext } from '../../../platform/database/database.js';
import type { Holiday, StoreAvailability, StoreSchedule } from '../contracts/schedule.js';
import { isStoreOpenAt } from '../domain/hours.js';

interface HourRow {
  weekday: number;
  start_minute: number;
  end_minute: number;
}
interface HolidayRow {
  day: string;
  closed: boolean;
  start_minute: number | null;
  end_minute: number | null;
}
export class PostgresStoreAvailability implements StoreAvailability {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly timezone: string,
  ) {}
  async isOpenAt(storeId: string, target: Date, tx?: TransactionContext): Promise<boolean> {
    const store = await sql<{
      buffer: number;
    }>`SELECT last_order_buffer_minutes AS buffer FROM stores WHERE id=${storeId}`.execute(
      tx ?? this.db,
    );
    if (!store.rows[0]) throw new Error('STORE_NOT_FOUND');
    const hours =
      await sql<HourRow>`SELECT weekday, start_minute, end_minute FROM store_hours WHERE store_id=${storeId}`.execute(
        tx ?? this.db,
      );
    const holidays =
      await sql<HolidayRow>`SELECT h.day::text, h.closed, w.start_minute, w.end_minute FROM store_holidays h LEFT JOIN store_holiday_hours w USING(store_id, day)
      WHERE h.store_id=${storeId} AND h.day BETWEEN ((${target}::timestamptz AT TIME ZONE ${this.timezone})::date - 1) AND (${target}::timestamptz AT TIME ZONE ${this.timezone})::date`.execute(
        tx ?? this.db,
      );
    const weekly: StoreSchedule['weekly'] = {};
    for (const hour of hours.rows)
      (weekly[hour.weekday] ??= []).push({
        startMinute: hour.start_minute,
        endMinute: hour.end_minute,
      });
    const holidayMap: Record<string, Holiday> = {};
    for (const holiday of holidays.rows) {
      const item = (holidayMap[holiday.day] ??= { closed: holiday.closed, windows: [] });
      if (holiday.start_minute !== null && holiday.end_minute !== null)
        item.windows.push({ startMinute: holiday.start_minute, endMinute: holiday.end_minute });
    }
    return isStoreOpenAt(
      {
        weekly,
        holidays: holidayMap,
        timezone: this.timezone,
        lastOrderBufferMinutes: store.rows[0].buffer,
      },
      target,
    );
  }
}
