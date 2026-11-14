import { get, post, put, patch, del, buildQuery } from './http'
import type { Brand, Category, CursorPage, PriceResult, Product, Variant } from '@/types'

// ── Catalog: categories / brands / products / variants / assortment / prices ─

interface BackendPage<T> { items: T[]; nextCursor: string | null }
interface NameRow { id: string; name: string }
interface ProductRow {
  id: string; name: string; categoryId: string; brandId: string | null; description: string
  hsnCode: string | null; gstRateBps: number | null; perishable: boolean; expiryTracking: boolean
  published: boolean
}
interface VariantRow {
  id: string; name: string; productId: string; baseUnit: 'PIECE' | 'GRAM' | 'MILLILITRE'
  sku: string; barcode: string | null
}

const mapProduct = (r: ProductRow): Product => ({
  id: r.id, name: r.name, categoryId: r.categoryId, brandId: r.brandId ?? null,
  description: r.description, hsnCode: r.hsnCode ?? null, gstRateBps: r.gstRateBps ?? null,
  perishable: r.perishable, expiryTracking: r.expiryTracking, published: !!r.published,
})
const mapVariant = (r: VariantRow): Variant => ({
  id: r.id, productId: r.productId, name: r.name, baseUnit: r.baseUnit, sku: r.sku, barcode: r.barcode ?? null,
})

async function page<T, R>(p: Promise<BackendPage<T>>, map: (row: T) => R): Promise<CursorPage<R>> {
  const res = await p
  return { items: (res.items ?? []).map(map), nextCursor: res.nextCursor ?? null }
}

// ── Categories ───────────────────────────────────────────────────────────────
export function listCategories(limit = 100, cursor?: string): Promise<CursorPage<Category>> {
  return page(get<BackendPage<NameRow>>(`/v1/admin/catalog/categories${buildQuery({ limit, cursor })}`), (r) => ({ id: r.id, name: r.name }))
}
export const createCategory = (name: string) => post<{ id: string }>('/v1/admin/catalog/categories', { name })
export const updateCategory = (id: string, name: string) => put<{ id: string }>(`/v1/admin/catalog/categories/${id}`, { name })
export const deleteCategory = (id: string) => del<unknown>(`/v1/admin/catalog/categories/${id}`)

// ── Brands ───────────────────────────────────────────────────────────────────
export function listBrands(limit = 100, cursor?: string): Promise<CursorPage<Brand>> {
  return page(get<BackendPage<NameRow>>(`/v1/admin/catalog/brands${buildQuery({ limit, cursor })}`), (r) => ({ id: r.id, name: r.name }))
}
export const createBrand = (name: string) => post<{ id: string }>('/v1/admin/catalog/brands', { name })
export const updateBrand = (id: string, name: string) => put<{ id: string }>(`/v1/admin/catalog/brands/${id}`, { name })
export const deleteBrand = (id: string) => del<unknown>(`/v1/admin/catalog/brands/${id}`)

// ── Products ─────────────────────────────────────────────────────────────────
export interface ProductInput {
  name: string
  categoryId: string
  brandId?: string | null
  description: string
  hsnCode?: string | null
  gstRateBps?: number | null
  perishable: boolean
  expiryTracking: boolean
}

export function listProducts(limit = 50, cursor?: string): Promise<CursorPage<Product>> {
  return page(get<BackendPage<ProductRow>>(`/v1/admin/catalog/products${buildQuery({ limit, cursor })}`), mapProduct)
}
export const getProduct = (id: string) => get<ProductRow>(`/v1/admin/catalog/products/${id}`).then(mapProduct)
export const createProduct = (input: ProductInput) => post<{ id: string }>('/v1/admin/catalog/products', input)
export const updateProduct = (id: string, input: ProductInput) => put<{ id: string }>(`/v1/admin/catalog/products/${id}`, input)
export const deleteProduct = (id: string) => del<unknown>(`/v1/admin/catalog/products/${id}`)
export const publishProduct = (id: string) => post<unknown>(`/v1/admin/catalog/products/${id}/publish`)
export const unpublishProduct = (id: string) => post<unknown>(`/v1/admin/catalog/products/${id}/unpublish`)

// ── Variants ─────────────────────────────────────────────────────────────────
export interface VariantInput {
  name: string
  productId: string
  sku: string
  barcode?: string | null
  baseUnit?: 'PIECE' | 'GRAM' | 'MILLILITRE'
}

export function listVariants(limit = 100, cursor?: string, productId?: string): Promise<CursorPage<Variant>> {
  return page(get<BackendPage<VariantRow>>(`/v1/admin/catalog/variants${buildQuery({ limit, cursor, productId })}`), mapVariant)
}
export const createVariant = (input: VariantInput) => post<{ id: string }>('/v1/admin/catalog/variants', input)
export const updateVariant = (id: string, input: VariantInput) => put<{ id: string }>(`/v1/admin/catalog/variants/${id}`, input)
export const deleteVariant = (id: string) => del<unknown>(`/v1/admin/catalog/variants/${id}`)

// ── Assortment & prices ──────────────────────────────────────────────────────
export const addAssortment = (storeId: string, variantId: string) =>
  post<unknown>('/v1/admin/catalog/assortment', { storeId, variantId })

export interface PriceInput {
  storeId: string
  variantId: string
  sellingPaise: string
  mrpPaise: string
  validFrom?: string | null
  validTo?: string | null
}

export const setPrice = (input: PriceInput) => post<PriceResult>('/v1/admin/catalog/prices', input)

// ── Catalog change approvals ─────────────────────────────────────────────────
export const approveCatalogChange = (approvalId: string) => post<unknown>(`/v1/admin/catalog/approvals/${approvalId}/approve`)

// ── Synonyms ─────────────────────────────────────────────────────────────────
export interface SynonymRow { term: string; expansion: string | null }
export function listSynonyms(limit = 50, cursor?: string): Promise<CursorPage<SynonymRow>> {
  return page(get<BackendPage<SynonymRow>>(`/v1/admin/catalog/synonyms${buildQuery({ limit, cursor })}`), (r) => ({ term: r.term, expansion: r.expansion ?? null }))
}
export const setSynonym = (term: string, expansion: string | null) =>
  put<unknown>('/v1/admin/catalog/synonyms', { term, expansion })

// ── Media targets (PRODUCT_IMAGE / CATALOG_IMPORT) ───────────────────────────
export interface CatalogMediaTarget { mediaId: string; url: string; fields: Record<string, string> }

export const createCatalogMediaTarget = (purpose: 'PRODUCT_IMAGE' | 'CATALOG_IMPORT', contentType: string, size: number) =>
  post<CatalogMediaTarget>('/v1/admin/catalog/media/targets', { purpose, contentType, size })

export const registerCatalogMedia = (mediaId: string, productId?: string) =>
  post<{ mediaId: string }>(`/v1/admin/catalog/media/${mediaId}/register`, productId ? { productId } : {})

/**
 * Upload a file to a presigned target (PUT body, no multipart — the target's
 * fields come back as headers when provided).
 */
export async function uploadToTarget(target: CatalogMediaTarget, file: File): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' }
  await fetch(target.url, { method: 'PUT', headers, body: file })
}

// ── Catalog imports (CSV) ────────────────────────────────────────────────────
export type CatalogImportStatus = 'QUEUED' | 'VALIDATING' | 'AWAITING_APPROVAL' | 'APPLYING' | 'COMPLETED' | 'FAILED'

export interface CatalogImport {
  id: string
  status: CatalogImportStatus
  dryRun: boolean
  rowsTotal: number
  checkpoint: number
  errors: Array<{ row: number; code: string }>
  approvalId: string | null
  createdAt: string
  updatedAt: string
}

export const createCatalogImport = (mediaId: string, storeId: string, dryRun: boolean) =>
  post<{ id: string }>('/v1/admin/catalog/imports', { mediaId, storeId, dryRun })
export const getCatalogImport = (id: string) => get<CatalogImport>(`/v1/admin/catalog/imports/${id}`)
export const approveCatalogImport = (approvalId: string) => post<unknown>(`/v1/admin/catalog/imports/approvals/${approvalId}/approve`)
/** Server-generated CSV report of import errors (opened in a new tab). */
export const catalogImportReportUrl = (id: string) => `/v1/admin/catalog/imports/${id}/report`
