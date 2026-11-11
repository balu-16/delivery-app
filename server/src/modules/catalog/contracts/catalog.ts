export const CATALOG_ADMIN = Symbol('CATALOG_ADMIN');
export const CATALOG_QUERY = Symbol('CATALOG_QUERY');
export interface ProductDraft {
  categoryId: string;
  brandId?: string | null;
  name: string;
  description: string;
  hsnCode?: string | null;
  gstRateBps?: number | null;
  perishable: boolean;
  expiryTracking: boolean;
}
export interface VariantDraft {
  productId: string;
  name: string;
  sku: string;
  barcode?: string | null;
  baseUnit?: 'PIECE' | 'GRAM' | 'MILLILITRE';
}
export interface PriceDraft {
  storeId: string;
  variantId: string;
  sellingPaise: string;
  mrpPaise: string;
  validFrom?: string | null;
  validTo?: string | null;
}
export interface CatalogAdmin {
  list(
    actor: string,
    kind: 'categories' | 'brands' | 'products' | 'variants',
    limit: number,
    cursor?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  get(
    actor: string,
    kind: 'categories' | 'brands' | 'products' | 'variants',
    id: string,
  ): Promise<unknown>;
  listSynonyms(
    actor: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: Array<{ term: string; expansion: string }>; nextCursor: string | null }>;
  saveNamed(
    actor: string,
    kind: 'categories' | 'brands',
    name: string,
    id?: string,
  ): Promise<string>;
  saveProduct(actor: string, data: ProductDraft, id?: string): Promise<string>;
  saveVariant(actor: string, data: VariantDraft, id?: string): Promise<string>;
  remove(
    actor: string,
    kind: 'categories' | 'brands' | 'products' | 'variants',
    id: string,
  ): Promise<void>;
  publish(actor: string, id: string, published: boolean): Promise<void>;
  setAssortment(actor: string, store: string, variant: string): Promise<void>;
  setPrice(actor: string, data: PriceDraft): Promise<{ approvalId?: string }>;
  approve(actor: string, requestId: string): Promise<void>;
  synonym(actor: string, term: string, expansion: string | null): Promise<void>;
}
export interface CatalogPageOptions {
  limit?: number;
  cursor?: string;
}
export interface CatalogReadResult {
  items: unknown[];
  etag: string;
  nextCursor: string | null;
}
export interface CatalogQuery {
  categories(
    user: string,
    address: string | undefined,
  ): Promise<Array<{ id: string; name: string }>>;
  favorites(user: string, cursor?: string): Promise<{ items: string[]; nextCursor: string | null }>;
  setFavorite(user: string, product: string, active: boolean): Promise<void>;
  list(
    user: string,
    address: string | undefined,
    options: CatalogPageOptions & {
      category?: string;
      product?: string;
      q?: string;
      suggest?: boolean;
      favorites?: boolean;
    },
  ): Promise<CatalogReadResult>;
}
