export interface VariantLookup {
  variantId: string;
  name: string;
}

export const CATALOG_LOOKUP = Symbol('CATALOG_LOOKUP');
export interface CatalogLookup {
  /** Barcode → variant within a store's assortment; unpublished/deleted variants never resolve. */
  variantByBarcode(storeId: string, barcode: string): Promise<VariantLookup | null>;
  variantById(variantId: string): Promise<VariantLookup | null>;
}
