import type { TransactionContext } from '../../../platform/database/database.js';
import type {
  ContactView,
  DeliverInput,
  DeliveryTaskView,
  DeliveryTasks,
  FailInput,
  OfferPage,
} from '../contracts/tasks.js';
import type { PostgresDeliveryTasks } from './postgres-delivery-tasks.js';
import type { PostgresTaskActions } from './postgres-task-actions.js';

/** Combines the offer/assignment flows with the custody action flows. */
export class DeliveryTasksFacade implements DeliveryTasks {
  constructor(
    private readonly tasks: PostgresDeliveryTasks,
    private readonly actions: PostgresTaskActions,
  ) {}
  offers(riderId: string): Promise<OfferPage> {
    return this.tasks.offers(riderId);
  }
  accept(riderId: string, offerId: string, reference: string): Promise<DeliveryTaskView> {
    return this.tasks.accept(riderId, offerId, reference);
  }
  decline(riderId: string, offerId: string, reference: string): Promise<{ state: 'DECLINED' }> {
    return this.tasks.decline(riderId, offerId, reference);
  }
  currentTask(riderId: string): Promise<DeliveryTaskView | null> {
    return this.tasks.currentTask(riderId);
  }
  arrivedAtStore(
    riderId: string,
    taskId: string,
    reference: string,
    point?: { lat: number; lng: number },
  ): Promise<DeliveryTaskView> {
    return this.actions.arrivedAtStore(riderId, taskId, reference, point);
  }
  pickedUp(riderId: string, taskId: string, reference: string): Promise<DeliveryTaskView> {
    return this.actions.pickedUp(riderId, taskId, reference);
  }
  arrived(
    riderId: string,
    taskId: string,
    reference: string,
    point?: { lat: number; lng: number },
  ): Promise<DeliveryTaskView> {
    return this.actions.arrived(riderId, taskId, reference, point);
  }
  deliver(
    riderId: string,
    taskId: string,
    input: DeliverInput,
    reference: string,
  ): Promise<DeliveryTaskView> {
    return this.actions.deliver(riderId, taskId, input, reference);
  }
  fail(
    riderId: string,
    taskId: string,
    input: FailInput,
    reference: string,
  ): Promise<DeliveryTaskView> {
    return this.actions.fail(riderId, taskId, input, reference);
  }
  contact(riderId: string, taskId: string): Promise<ContactView | null> {
    return this.actions.contact(riderId, taskId);
  }
  recordContactAttempt(
    riderId: string,
    taskId: string,
    reference: string,
  ): Promise<{ recordedAt: string }> {
    return this.actions.recordContactAttempt(riderId, taskId, reference);
  }
  codCollect(
    riderId: string,
    taskId: string,
    input: { amountPaise: string },
    reference: string,
  ): Promise<{
    orderId: string;
    collectedPaise: string;
    expectedPaise: string | null;
    mismatch: boolean;
  }> {
    return this.actions.codCollect(riderId, taskId, input, reference);
  }
}

export type { TransactionContext };
