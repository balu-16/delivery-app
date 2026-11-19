import { ApiError } from '../api/client';

export const favoritesStorageKey = (userId: string) => `@dairydirect/favorites-v1:${userId}`;

/** Last-confirmed favorite IDs must be a plain list of product IDs; anything else is ignored. */
export function parseFavoriteIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 5000) return null;
  if (!value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) return null;
  return [...new Set(value)];
}

/** Visible favorites: last-confirmed IDs with every pending per-product intent applied. */
export function applyFavoriteDesires(confirmed: string[], desired: ReadonlyMap<string, boolean>): string[] {
  const visible = new Set(confirmed);
  for (const [id, active] of desired) {
    if (active) visible.add(id);
    else visible.delete(id);
  }
  return [...visible];
}

/**
 * Only a definitive client rejection reverts a favorite tap. Timeouts, network
 * errors, rate limits, and server errors stay ambiguous and keep the latest intent.
 */
export function isDefinitiveFavoriteError(error: unknown): boolean {
  return error instanceof ApiError && error.status < 500 && ![408, 429].includes(error.status);
}
