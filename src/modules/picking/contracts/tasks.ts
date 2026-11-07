import type { TransactionContext } from '../../../platform/database/database.js';
import type { StoreOrderSummary } from './fulfillment.js';

export type PickTaskStatus = 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type PickItemStatus = 'PENDING' | 'PICKED' | 'SHORT' | 'SUBSTITUTED';
export type ShortReason = 'OUT_OF_STOCK' | 'DAMAGED' | 'EXPIRED' | 'NOT_FOUND';

export interface PickItemView {
  id: string;
  orderItemId: string;
  variantId: string;
  substituteVariantId: string | null;
  name: string;
  expectedQty: string;
  pickedQty: string;
  batchId: string | null;
  status: PickItemStatus;
  shortReason: ShortReason | null;
  /** Earliest eligible batch suggestion for perishables (FEFO, shelf-life filtered). */
  fefoSuggestions: {
    batchId: string;
    batchCode: string;
    expiresAt: string | null;
    availableQty: string;
  }[];
}

export interface PickTaskView {
  id: string;
  orderId: string;
  storeId: string;
  status: PickTaskStatus;
  assignedTo: string | null;
  startedAt: string | null;
  slaDueAt: string;
  completedAt: string | null;
  version: string;
  items: PickItemView[];
}

export interface PickTaskPage {
  items: PickTaskView[];
  nextCursor: string | null;
}

export interface QueueInput {
  storeId: string;
  /** QUEUE: unclaimed tasks; MINE: tasks assigned to the caller; ALL: store board (manager). */
  scope: 'QUEUE' | 'MINE' | 'ALL';
  cursor?: string;
  limit?: number;
}

export interface PickItemInput {
  /** Scanned barcode must resolve to the expected variant (or the substitution candidate). */
  scannedBarcode: string;
  quantity: string;
  /** Required when the variant tracks batches (perishables): FEFO suggestion or scanned batch. */
  batchId?: string;
}

export interface ShortInput {
  reason: ShortReason;
}

export interface SubstitutionInput {
  /** Must be a listed substitute candidate for the expected variant. */
  candidateVariantId: string;
  scannedBarcode: string;
  batchId?: string;
}

export interface ClaimResult {
  task: PickTaskView;
}

export interface KpiSummary {
  openTasks: number;
  completedToday: number;
  slaBreachesToday: number;
  avgPickSeconds: string;
  shortRateBps: string;
  backlog: number;
}

export interface SlaTask {
  id: string;
  orderId: string;
  status: 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS';
  assignedTo: string | null;
  slaDueAt: string;
  breached: boolean;
}

export interface SlaTaskPage {
  items: SlaTask[];
  nextCursor: string | null;
}

export interface StoreStaffMember {
  userId: string;
  name: string;
  role: 'PICKER' | 'STORE_MANAGER';
  activeTasks: number;
}

export interface StoreStaffPage {
  items: StoreStaffMember[];
  nextCursor: string | null;
}

export const PICK_TASKS = Symbol('PICK_TASKS');
export interface PickTasks {
  /** Walk-ordered queue of tasks; pick lists sort by bin location then item id. */
  queue(actorId: string, input: QueueInput): Promise<PickTaskPage>;
  /** Self-claim under SKIP LOCKED; two pickers can never claim the same task. */
  claim(actorId: string, taskId: string, reference: string): Promise<ClaimResult>;
  start(actorId: string, taskId: string, reference: string): Promise<PickTaskView>;
  pickItem(
    actorId: string,
    taskId: string,
    itemId: string,
    input: PickItemInput,
    reference: string,
  ): Promise<PickTaskView>;
  shortItem(
    actorId: string,
    taskId: string,
    itemId: string,
    input: ShortInput,
    reference: string,
  ): Promise<PickTaskView>;
  substituteItem(
    actorId: string,
    taskId: string,
    itemId: string,
    input: SubstitutionInput,
    reference: string,
  ): Promise<PickTaskView>;
  /** Consumes fulfilled stock through inventory contracts and settles shorts once. */
  complete(actorId: string, taskId: string, reference: string): Promise<PickTaskView>;
  /** Manager reassignment; pick progress is preserved. */
  reassign(
    actorId: string,
    taskId: string,
    toUserId: string,
    reason: string,
    reference: string,
  ): Promise<PickTaskView>;
  /** Manager board metrics over picking-owned data. */
  kpis(actorId: string, storeId: string): Promise<KpiSummary>;
  slaBoard(actorId: string, storeId: string, cursor?: string, limit?: number): Promise<SlaTaskPage>;
  /** Staff roster with active task counts. */
  staff(actorId: string, storeId: string, cursor?: string, limit?: number): Promise<StoreStaffPage>;
  /** Store order queue via the P6 read contract. */
  storeOrders(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: StoreOrderSummary[]; nextCursor: string | null }>;
}

/** Compensating cancel issued by order cancellation (P6 contract) or all-short completion. */
export const PICK_CANCELLATION = Symbol('PICK_CANCELLATION');
export interface PickCancellation {
  cancel(orderId: string, reason: string, tx?: TransactionContext): Promise<void>;
}
