import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import {
  APP_CONTENT_LOCALES,
  APP_CONTENT_SLOTS,
  slotsFor,
  type AppContentAudience,
  type AppContentRecord,
  type AppContentHistoryEntry,
  type AppContentService,
  type AppContentSlot,
  type AudienceAppContentItem,
} from '../contracts/app-content.js';
import { assertLocale, assertSlot, effectiveState, validateWrite } from '../domain/app-content.js';

interface Row {
  slot: AppContentSlot;
  locale: 'en' | 'hi' | 'te';
  enabled: boolean;
  title: string | null;
  body: string | null;
  image_media_id: string | null;
  destination: string | null;
  start_at: string | null;
  end_at: string | null;
  version: number;
  updated_by: string | null;
  updated_at: string;
}

function toRecord(row: Row): AppContentRecord {
  return {
    slot: row.slot,
    locale: row.locale,
    enabled: row.enabled,
    title: row.title,
    body: row.body,
    imageMediaId: row.image_media_id,
    imageUrl: row.image_media_id ? `/media/${row.image_media_id}` : null,
    destination: row.destination,
    startAt: row.start_at,
    endAt: row.end_at,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** App-content service (customize2 §3E): slot+locale rows with versioned
 * history for restore; audience reads independent of admin config/audit. */
export class PostgresAppContent implements AppContentService {
  constructor(private readonly db: Database) {}

  async listAdmin(): Promise<AppContentRecord[]> {
    const rows =
      await sql<Row>`SELECT slot,locale,enabled,title,body,image_media_id,destination,start_at::text AS start_at,end_at::text AS end_at,version,updated_by,updated_at::text AS updated_at FROM app_content ORDER BY slot,locale`.execute(
        this.db,
      );
    const byKey = new Map(rows.rows.map((row) => [`${row.slot}|${row.locale}`, row]));
    const out: AppContentRecord[] = [];
    for (const slot of APP_CONTENT_SLOTS) {
      for (const locale of APP_CONTENT_LOCALES) {
        const found = byKey.get(`${slot}|${locale}`);
        if (found) out.push(toRecord(found));
        else
          out.push({
            slot,
            locale,
            enabled: false,
            title: null,
            body: null,
            imageMediaId: null,
            imageUrl: null,
            destination: null,
            startAt: null,
            endAt: null,
            version: 0,
            updatedBy: null,
            updatedAt: new Date(0).toISOString(),
          });
      }
    }
    return out;
  }

  async write(
    actor: string,
    slot: string,
    locale: string,
    input: Parameters<AppContentService['write']>[3],
  ): Promise<AppContentRecord> {
    validateWrite(slot, locale, input);
    assertSlot(slot);
    assertLocale(locale);
    if (input.imageMediaId) {
      const media =
        await sql`SELECT id FROM catalog_media WHERE id=${input.imageMediaId}::uuid AND purpose='CONTENT_IMAGE' AND state='REGISTERED'`.execute(
          this.db,
        );
      if (!media.rows.length) throw new Error('INVALID_INPUT');
    }
    return this.db.transaction().execute(async (tx) => {
      const allowed =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actor}::uuid AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') LIMIT 1`.execute(
          tx,
        );
      if (!allowed.rows.length) throw new Error('FORBIDDEN');
      const existing =
        await sql<Row>`SELECT slot,locale,enabled,title,body,image_media_id,destination,start_at::text AS start_at,end_at::text AS end_at,version,updated_by,updated_at::text AS updated_at FROM app_content WHERE slot=${slot} AND locale=${locale}`.execute(
          tx,
        );
      const current = existing.rows[0];
      const expected = input.expectedVersion ?? 0;
      if ((current?.version ?? 0) !== expected) throw new Error('CONCURRENT_MODIFICATION');
      if (current) {
        await sql`INSERT INTO app_content_history(id,slot,locale,version,enabled,title,body,image_media_id,destination,start_at,end_at,updated_by) VALUES(${uuidV7()}::uuid,${current.slot},${current.locale},${current.version},${current.enabled},${current.title},${current.body},${current.image_media_id},${current.destination},${current.start_at}::timestamptz,${current.end_at}::timestamptz,${current.updated_by})`.execute(
          tx,
        );
      }
      const version = (current?.version ?? 0) + 1;
      const startAt = input.startAt ? new Date(input.startAt).toISOString() : null;
      const endAt = input.endAt ? new Date(input.endAt).toISOString() : null;
      const upserted =
        await sql<Row>`INSERT INTO app_content(slot,locale,enabled,title,body,image_media_id,destination,start_at,end_at,version,updated_by,updated_at) VALUES(${slot},${locale},${input.enabled},${input.title ?? null},${input.body ?? null},${input.imageMediaId ?? null},${input.destination ?? null},${startAt}::timestamptz,${endAt}::timestamptz,${version},${actor}::uuid,clock_timestamp()) ON CONFLICT (slot,locale) DO UPDATE SET enabled=EXCLUDED.enabled,title=EXCLUDED.title,body=EXCLUDED.body,image_media_id=EXCLUDED.image_media_id,destination=EXCLUDED.destination,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING slot,locale,enabled,title,body,image_media_id,destination,start_at::text AS start_at,end_at::text AS end_at,version,updated_by,updated_at::text AS updated_at`.execute(
          tx,
        );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'APP_CONTENT_WRITTEN','app_content',${`${slot}:${locale}`},${JSON.stringify({ before: current ? toRecord(current) : null, after: toRecord(upserted.rows[0] as Row) })}::jsonb)`.execute(
        tx,
      );
      return toRecord(upserted.rows[0] as Row);
    });
  }

  async history(slot: string, locale: string): Promise<AppContentHistoryEntry[]> {
    assertSlot(slot);
    assertLocale(locale);
    const rows = await sql<{
      id: string;
      version: number;
      enabled: boolean;
      title: string | null;
      body: string | null;
      image_media_id: string | null;
      destination: string | null;
      start_at: string | null;
      end_at: string | null;
      updated_by: string | null;
      created_at: string;
    }>`SELECT id,version,enabled,title,body,image_media_id,destination,start_at::text AS start_at,end_at::text AS end_at,updated_by,created_at::text AS created_at FROM app_content_history WHERE slot=${slot} AND locale=${locale} ORDER BY version DESC LIMIT 50`.execute(
      this.db,
    );
    return rows.rows.map((row) => ({
      id: row.id,
      version: row.version,
      enabled: row.enabled,
      title: row.title,
      body: row.body,
      imageMediaId: row.image_media_id,
      destination: row.destination,
      startAt: row.start_at,
      endAt: row.end_at,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
    }));
  }

  async audience(
    audience: AppContentAudience,
    locale: string | null | undefined,
    now?: Date,
  ): Promise<AudienceAppContentItem[]> {
    const at = now ?? new Date();
    const wanted = locale === 'hi' || locale === 'te' || locale === 'en' ? locale : 'en';
    const slots = slotsFor(audience);
    const rows =
      await sql<Row>`SELECT slot,locale,enabled,title,body,image_media_id,destination,start_at::text AS start_at,end_at::text AS end_at,version,updated_by,updated_at::text AS updated_at FROM app_content WHERE slot = ANY(${slots}::text[]) AND locale IN (${wanted},'en')`.execute(
        this.db,
      );
    const bySlot = new Map<string, Row[]>();
    for (const row of rows.rows) {
      const list = bySlot.get(row.slot) ?? [];
      list.push(row);
      bySlot.set(row.slot, list);
    }
    return slots.map((slot) => {
      const candidates = bySlot.get(slot) ?? [];
      const resolved =
        candidates.find((row) => row.locale === wanted) ??
        candidates.find((row) => row.locale === 'en') ??
        null;
      if (!resolved) {
        return {
          slot,
          state: 'UNSET' as const,
          locale: null,
          title: null,
          body: null,
          imageMediaId: null,
          imageUrl: null,
          destination: null,
          version: null,
        };
      }
      const state = effectiveState(resolved, at);
      const published = state === 'VISIBLE';
      return {
        slot,
        state,
        locale: resolved.locale,
        title: published ? resolved.title : null,
        body: published ? resolved.body : null,
        imageMediaId: published ? resolved.image_media_id : null,
        imageUrl: published && resolved.image_media_id ? `/media/${resolved.image_media_id}` : null,
        destination: published ? resolved.destination : null,
        version: resolved.version,
      };
    });
  }
}
