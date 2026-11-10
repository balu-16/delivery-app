import type { OrderCodes } from '../../orders/contracts/orders.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { DeliveryCodes } from '../contracts/tasks.js';
export class CanonicalDeliveryCodes implements DeliveryCodes {
  constructor(private readonly codes: OrderCodes) {}
  async issue(orderId: string, tx?: TransactionContext) {
    await this.codes.issue(orderId, tx);
    return { state: 'PENDING' as const };
  }
  async present(orderId: string, userId: string, role: 'RIDER' | 'CUSTOMER') {
    if (role !== 'CUSTOMER') throw new Error('RESOURCE_NOT_FOUND');
    return this.codes.present(orderId, userId);
  }
  async verify(orderId: string, code: string, _actorId: string) {
    if (!(await this.codes.verify(orderId, code))) throw new Error('DELIVERY_CODE_INVALID');
    return { state: 'VERIFIED' as const };
  }
}
