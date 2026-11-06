export const CATALOG_IMPORTS = Symbol('CATALOG_IMPORTS');
export interface CatalogImports {
  create(owner: string, mediaId: string, storeId: string, dryRun: boolean): Promise<{ id: string }>;
  get(owner: string, id: string): Promise<unknown>;
  report(owner: string, id: string): Promise<string>;
  approve(checker: string, id: string): Promise<void>;
}
