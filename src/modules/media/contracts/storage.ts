import type { Readable } from 'node:stream';
export interface StoragePort {
  upload?(id: string, token: string, body: Buffer): Promise<void>;
  target(
    key: string,
    type: string,
    size: number,
    expires: number,
  ): Promise<{ url: string; fields: Record<string, string> }>;
  inspect(key: string): Promise<{ size: number; type: string; etag: string }>;
  promote(source: string, destination: string, etag: string): Promise<void>;
  /** Server-only immutable write to a private key, never a client upload capability. */
  putPrivate(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  open(key: string): Promise<Readable>;
}
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
export interface CatalogMedia {
  target(
    owner: string,
    purpose: 'PRODUCT_IMAGE' | 'CATALOG_IMPORT',
    type: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }>;
  register(owner: string, id: string, productId?: string): Promise<void>;
  publicRead(id: string): Promise<{ body: Readable; contentType: string }>;
}
export const CATALOG_MEDIA = Symbol('CATALOG_MEDIA');
