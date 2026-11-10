export interface ShelfLifeInput {
  categoryId: string;
  minSeconds: number;
  expectedVersion: string;
  reason: string;
  reference: string;
}
export interface InventoryShelfLife {
  set(actor: string, input: ShelfLifeInput): Promise<void>;
  list(
    actor: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: Array<{ categoryId: string; minSeconds: number; version: string }>;
    nextCursor: string | null;
  }>;
}
export const INVENTORY_SHELF_LIFE = Symbol('INVENTORY_SHELF_LIFE');
