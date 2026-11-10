export const ORDER_ADMINISTRATION = Symbol('ORDER_ADMINISTRATION');
export interface OrderAdministration {
  requestRefund(
    makerId: string,
    orderId: string,
    input: { amountPaise: string; reason: string },
    reference: string,
  ): Promise<string>;
  requestTicketAdminRefund(
    makerId: string,
    orderId: string,
    input: { amountPaise: string; reason: string },
    reference: string,
  ): Promise<string>;
  requestSupportRefund(
    makerId: string,
    orderId: string,
    input: { amountPaise: string; reason: string },
    reference: string,
  ): Promise<string>;
  requestRepair(
    makerId: string,
    orderId: string,
    input: { state: 'CANCELLED' | 'EXPIRED'; reason: string },
    reference: string,
  ): Promise<string>;
  approve(checkerId: string, requestId: string): Promise<void>;
}
