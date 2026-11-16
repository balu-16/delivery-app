import type { TransactionContext } from '../../../platform/database/database.js';
import type { StoreOrderSummary } from './fulfillment.js';

export type PickTaskStatus = 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type PickItemStatus = 'PENDING' | 'PICKED' | 'SHORT' | 'SUBSTITUTED';
export type ShortReason = 'OUT_OF_STOCK' | 'DAMAGED' | 'EXPIRED' | 'NOT_FOUND';

export interface PickSubstitutionCandidateView {
  variantId: string;
  name: string;
  sku: string;
  barcode: string | null;
  available: string;
}

export interface PickItemView {
  id: string;
  orderItemId: string;
  variantId: string;
  substituteVariantId: string | null;
  name: string;
  sku: string;
  barcode: string | null;
  expectedQty: string;
  pickedQty: string;
  batchId: string | null;
  batchCode: string | null;
  batchExpiresAt: string | null;
  status: PickItemStatus;
  shortReason: ShortReason | null;
  /** Earliest eligible batch suggestion for perishables (FEFO, shelf-life filtered). */
  fefoSuggestions: {
    batchId: string;
    batchCode: string;
    expiresAt: string | null;
    availableQty: string;
  }[];
  /** Listed substitutes with current store availability (server still re-validates). */
  substitutionCandidates: PickSubstitutionCandidateView[];
}

export interface PickPackingView {
  bags: number;
  sealCode: string;
  coldChain: boolean;
  packedAt: string;
  packedBy: string | null;
}

export interface PickHandoverView {
  state: 'PENDING' | 'VERIFIED' | 'OVERRIDE';
  riderId: string | null;
  riderName: string | null;
  attempts: number;
  locked: boolean;
  verifiedAt: string | null;
  deliveryStatus: string | null;
}

export interface PickTaskView {
  id: string;
  orderId: string;
  orderNumber: string | null;
  orderStatus: string;
  customerName: string;
  storeId: string;
  status: PickTaskStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  startedAt: string | null;
  slaDueAt: string;
  completedAt: string | null;
  version: string;
  packing: PickPackingView | null;
  handover: PickHandoverView | null;
  deliveryStatus: string | null;
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
  batches?: { batchId: string; quantity: string }[];
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

/** Store-board counts and today's hourly series. Zeros are real empty buckets. */
export interface PickingBoard {
  waiting: number;
  beingPicked: number;
  readyToPack: number;
  readyForHandover: number;
  hourly: Array<{ label: string; completed: number; open: number }>;
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
  role: 'STORE_MANAGER';
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
  /** Single task with items and FEFO suggestions, authorized for the task's store. */
  get(actorId: string, taskId: string): Promise<PickTaskView>;
  /** Manager release: returns a claimed-but-not-started task to the unclaimed queue. */
  release(actorId: string, taskId: string, reference: string): Promise<PickTaskView>;
  heartbeat(actorId: string, taskId: string): Promise<void>;
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
  /** Status buckets and today's hourly completed/open counts for the store board. */
  board(actorId: string, storeId: string): Promise<PickingBoard>;
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
