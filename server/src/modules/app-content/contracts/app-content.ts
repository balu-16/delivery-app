/** App-content contracts (customize2 §3E): 5 slots keyed by slot+locale. */
export type AppContentLocale = 'en' | 'hi' | 'te';
export type AppContentSlot =
  | 'CUSTOMER_HOME_BANNER'
  | 'CUSTOMER_OFFERS_CARD'
  | 'RIDER_HOME_ANNOUNCEMENT'
  | 'CUSTOMER_HELP'
  | 'RIDER_HELP';
export type AppContentAudience = 'CUSTOMER' | 'RIDER';

export const APP_CONTENT_SLOTS: readonly AppContentSlot[] = [
  'CUSTOMER_HOME_BANNER',
  'CUSTOMER_OFFERS_CARD',
  'RIDER_HOME_ANNOUNCEMENT',
  'CUSTOMER_HELP',
  'RIDER_HELP',
];
export const APP_CONTENT_LOCALES: readonly AppContentLocale[] = ['en', 'hi', 'te'];

export function slotsFor(audience: AppContentAudience): AppContentSlot[] {
  return audience === 'CUSTOMER'
    ? ['CUSTOMER_HOME_BANNER', 'CUSTOMER_OFFERS_CARD', 'CUSTOMER_HELP']
    : ['RIDER_HOME_ANNOUNCEMENT', 'RIDER_HELP'];
}

/** Per-slot destination allowlist (prefix match). */
export const SLOT_DESTINATIONS: Readonly<Record<AppContentSlot, readonly string[]>> = {
  CUSTOMER_HOME_BANNER: ['/products', '/cart', '/support'],
  CUSTOMER_OFFERS_CARD: ['/cart', '/offers', '/products', '/support'],
  RIDER_HOME_ANNOUNCEMENT: ['/support', '/notifications'],
  CUSTOMER_HELP: ['/support'],
  RIDER_HELP: ['/support', '/notifications'],
};

export type AppContentState = 'UNSET' | 'VISIBLE' | 'DISABLED' | 'INACTIVE';

export interface AppContentRecord {
  slot: AppContentSlot;
  locale: AppContentLocale;
  enabled: boolean;
  title: string | null;
  body: string | null;
  imageMediaId: string | null;
  imageUrl: string | null;
  destination: string | null;
  startAt: string | null;
  endAt: string | null;
  version: number;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AudienceAppContentItem {
  slot: AppContentSlot;
  state: AppContentState;
  locale: AppContentLocale | null;
  title: string | null;
  body: string | null;
  imageMediaId: string | null;
  imageUrl: string | null;
  destination: string | null;
  version: number | null;
}

export interface AppContentWrite {
  enabled: boolean;
  title?: string | null;
  body?: string | null;
  imageMediaId?: string | null;
  destination?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  expectedVersion?: number;
}

export interface AppContentHistoryEntry {
  id: string;
  version: number;
  enabled: boolean;
  title: string | null;
  body: string | null;
  imageMediaId: string | null;
  destination: string | null;
  startAt: string | null;
  endAt: string | null;
  updatedBy: string | null;
  createdAt: string;
}

export const APP_CONTENT = Symbol('APP_CONTENT');
export interface AppContentService {
  /** Admin list: configured rows plus synthesized defaults for unset slots. */
  listAdmin(): Promise<AppContentRecord[]>;
  /** Admin write (publish/disable/restore) with optimistic version. */
  write(
    actor: string,
    slot: string,
    locale: string,
    input: AppContentWrite,
  ): Promise<AppContentRecord>;
  /** Admin history for restore. */
  history(slot: string, locale: string): Promise<AppContentHistoryEntry[]>;
  /** Audience read: locale fallback, unset-vs-disabled-vs-inactive, server-time UTC windows. */
  audience(
    audience: AppContentAudience,
    locale: string | null | undefined,
    now?: Date,
  ): Promise<AudienceAppContentItem[]>;
}
