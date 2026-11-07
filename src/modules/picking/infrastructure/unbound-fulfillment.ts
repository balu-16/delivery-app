import type {
  AdjustmentSummary,
  FinancialAdjustments,
  OrderCancellation,
  OrderFulfillment,
  OrderFulfillmentReads,
  ShortAdjustmentLine,
  StoreOrderSummary,
} from '../contracts/fulfillment.js';

/**
 * Fail-closed stand-in bound until P6's real order/financial contracts are
 * wired (ADR 0010). Every call throws a typed error that surfaces as 503 and
 * rolls the caller's transaction back, so no picking state ever diverges from
 * the order state machine.
 */
export class UnboundFulfillment
  implements OrderFulfillment, FinancialAdjustments, OrderCancellation, OrderFulfillmentReads
{
  private unavailable(): never {
    throw new Error('FULFILLMENT_DEPENDENCY_UNAVAILABLE');
  }
  startPicking(): Promise<void> {
    return this.unavailable();
  }
  markPacked(): Promise<void> {
    return this.unavailable();
  }
  recordShort(_input: {
    orderId: string;
    actorId: string;
    lines: ShortAdjustmentLine[];
  }): Promise<AdjustmentSummary> {
    return this.unavailable();
  }
  systemCancel(_orderId: string, _reason: string): Promise<void> {
    return this.unavailable();
  }
  storeOrders(
    _storeId: string,
    _cursor?: string,
    _limit?: number,
  ): Promise<{ items: StoreOrderSummary[]; nextCursor: string | null }> {
    return this.unavailable();
  }
  orderSummary(_orderId: string): Promise<StoreOrderSummary | null> {
    return this.unavailable();
  }
}
