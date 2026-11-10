export const COMPLIANCE_EXPORTS = Symbol('COMPLIANCE_EXPORTS');
export type ExportAudience = 'CUSTOMER' | 'ADMIN';
export interface ExportFilters {
  storeId?: string;
  from?: string;
  to?: string;
}
export interface ComplianceExports {
  create(
    owner: string,
    audience: ExportAudience,
    kind: string,
    filters: ExportFilters,
    key: string,
  ): Promise<string>;
  list(
    owner: string,
    audience: ExportAudience,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  detail(owner: string, audience: ExportAudience, id: string): Promise<unknown>;
  download(owner: string, audience: ExportAudience, id: string): Promise<{ url: string }>;
  preview(
    kind: string,
    cursor: string | undefined,
    limit: number,
    filters: ExportFilters,
  ): Promise<unknown>;
}
