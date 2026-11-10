import type { CatalogPageOptions, CatalogReadResult } from './catalog.js';
/** Replaceable search boundary; PostgreSQL maintains indexes alongside product writes. */
export interface SearchPort {
  indexProduct(productId: string): Promise<void>;
  searchProducts(
    userId: string,
    addressId: string | undefined,
    query: string,
    page?: CatalogPageOptions,
  ): Promise<CatalogReadResult>;
  suggest(
    userId: string,
    addressId: string | undefined,
    query: string,
    page?: CatalogPageOptions,
  ): Promise<CatalogReadResult>;
}
export const SEARCH_PORT = Symbol('SEARCH_PORT');
