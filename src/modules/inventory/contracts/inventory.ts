import type { TransactionContext } from '../../../platform/database/database.js';

/** Quantities are decimal strings in whole saleable units of the variant. */
export interface ReservationLine {
  storeId: string;
  variantId: string;
  quantity: string;
}
export interface ReserveInput {
  orderId: string;
  lines: ReservationLine[];
  targetDeliveryAt: string;
  ttlSeconds: number;
}
export interface PickLine {
  storeId: string;
  variantId: string;
  quantity: string;
}
export interface InventoryReservations {
  reserve(input: ReserveInput, tx?: TransactionContext): Promise<void>;
  commit(orderId: string, tx?: TransactionContext): Promise<void>;
  release(orderId: string, tx?: TransactionContext): Promise<void>;
  pick(orderId: string, lines: PickLine[], tx?: TransactionContext): Promise<void>;
}
export const INVENTORY_RESERVATIONS = Symbol('INVENTORY_RESERVATIONS');
export interface ReceiptInput {
  storeId: string;
  variantId: string;
  batchCode: string;
  quantity: string;
  expiresAt?: string | null;
  reference: string;
}
export interface InventoryManagement {
  receive(actor: string, input: ReceiptInput): Promise<void>;
  list(
    actor: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
    lowStock?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  expiring(
    actor: string,
    storeId: string,
    days: number,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  report(
    actor: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  ledger(
    actor: string,
    storeId: string,
    variantId?: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
}
export const INVENTORY_MANAGEMENT = Symbol('INVENTORY_MANAGEMENT');
