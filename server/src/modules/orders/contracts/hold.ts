export const ORDER_HOLDS = Symbol('ORDER_HOLDS');
export interface OrderHolds {
  set(orderId: string, adminId: string, held: boolean, reason: string): Promise<void>;
  get(orderId: string): Promise<{
    held: boolean;
    reason: string | null;
    actorId: string | null;
    heldAt: string | null;
  }>;
}
