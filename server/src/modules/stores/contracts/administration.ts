export interface StoreDraft {
  legalEntityId: string;
  cityId: string;
  name: string;
  lat: number;
  lng: number;
  hourlyCapacity: number;
  lastOrderBufferMinutes: number;
}
export interface HoursEntry {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
export interface HolidayEntry {
  day: string;
  closed: boolean;
  windows: Array<{ startMinute: number; endMinute: number }>;
}
export interface StoreAdministration {
  list(
    actorId: string,
    kind: 'legal_entities' | 'cities' | 'stores' | 'zones',
    limit: number,
    cursor?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  operations(
    actorId: string,
    storeId: string,
    page: { limit: number; holidayCursor?: string; staffCursor?: string },
  ): Promise<unknown>;
  saveEntity(actorId: string, name: string, id?: string): Promise<string>;
  saveCity(actorId: string, name: string, bounds: object, id?: string): Promise<string>;
  saveStore(actorId: string, draft: StoreDraft, id?: string): Promise<string>;
  setCod(
    actorId: string,
    storeId: string,
    enabled: boolean,
    version: string,
  ): Promise<{ enabled: boolean; version: string }>;
  delete(actorId: string, kind: 'legal_entities' | 'cities' | 'stores', id: string): Promise<void>;
  hours(actorId: string, storeId: string, entries: HoursEntry[]): Promise<void>;
  holiday(actorId: string, storeId: string, entry: HolidayEntry): Promise<void>;
  deleteHoliday(actorId: string, storeId: string, day: string): Promise<void>;
  assign(
    actorId: string,
    storeId: string,
    userId: string,
    role: 'STORE_MANAGER',
    active: boolean,
  ): Promise<void>;
}
export const STORE_ADMINISTRATION = Symbol('STORE_ADMINISTRATION');
