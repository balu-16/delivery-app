import type { TransactionContext } from '../../../platform/database/database.js';

/** The caller must first acquire the customer account lock. */
export const SUBSCRIPTION_OBLIGATIONS = Symbol('SUBSCRIPTION_OBLIGATIONS');
export interface SubscriptionObligations {
  hasLiveObligations(userId: string, tx: TransactionContext): Promise<boolean>;
}

export const ADDRESS_SUBSCRIPTIONS = Symbol('ADDRESS_SUBSCRIPTIONS');
export interface AddressSubscriptions {
  pauseForDeletedAddress(
    userId: string,
    addressId: string,
    tx: TransactionContext,
  ): Promise<number>;
}

export type FrequencyRule =
  | { type: 'DAILY' }
  | { type: 'ALTERNATE_DAYS' }
  | { type: 'WEEKDAYS'; days: number[] }
  | { type: 'EVERY_N_DAYS'; n: number };
export const SUBSCRIPTIONS = Symbol('SUBSCRIPTIONS');
export interface CreateSubscriptionInput {
  variantId: string;
  quantity: string;
  frequencyRule: FrequencyRule;
  startDate: string;
  endDate?: string;
  slotId: string;
  addressId: string;
}
export interface SubscriptionChanges {
  quantity?: string;
  frequencyRule?: FrequencyRule;
  slotId?: string;
  addressId?: string;
}
export interface CustomerSubscriptionOptions {
  enabled: boolean;
  eligible: boolean;
  firstStartDate: string;
  slots: Array<{ id: string; name: string; startTime: string; endTime: string }>;
}
export interface SubscriptionOperations {
  options(
    userId: string,
    addressId: string,
    variantId: string,
  ): Promise<CustomerSubscriptionOptions>;
  change(
    userId: string,
    id: string,
    input: SubscriptionChanges,
    tx?: TransactionContext,
  ): Promise<unknown>;
  create(userId: string, input: CreateSubscriptionInput, tx?: TransactionContext): Promise<unknown>;
  list(userId: string, limit?: number, cursor?: string): Promise<unknown>;
  get(userId: string, id: string): Promise<unknown>;
  upcoming(userId: string, id: string, from: string, to: string, limit?: number): Promise<unknown>;
  calendar(userId: string, month: string, limit?: number, cursor?: string): Promise<unknown>;
  quantity(userId: string, id: string, quantity: string, tx?: TransactionContext): Promise<unknown>;
  pause(
    userId: string,
    id: string,
    from: string,
    to: string,
    tx?: TransactionContext,
  ): Promise<unknown>;
  resume(userId: string, id: string, tx?: TransactionContext): Promise<unknown>;
  skip(
    userId: string,
    id: string,
    date: string,
    remove?: boolean,
    tx?: TransactionContext,
  ): Promise<unknown>;
  cancel(userId: string, id: string, tx?: TransactionContext): Promise<unknown>;
}
export const SUBSCRIPTION_ADMIN = Symbol('SUBSCRIPTION_ADMIN');
export interface SubscriptionAdmin {
  plans(limit?: number, cursor?: string): Promise<unknown>;
  savePlan(
    actorId: string,
    variantId: string,
    active: boolean,
    tx?: TransactionContext,
  ): Promise<unknown>;
  slots(storeId: string, limit?: number, cursor?: string): Promise<unknown>;
  saveSlot(
    actorId: string,
    input: {
      id?: string;
      storeId: string;
      name: string;
      startTime: string;
      endTime: string;
      active: boolean;
    },
    tx?: TransactionContext,
  ): Promise<unknown>;
  holidays(storeId: string, limit?: number, cursor?: string): Promise<unknown>;
  saveHoliday(
    actorId: string,
    storeId: string,
    date: string,
    reason: string | null,
    remove: boolean,
    tx?: TransactionContext,
  ): Promise<unknown>;
  runs(storeId?: string, limit?: number, cursor?: string): Promise<unknown>;
  retryRun(actorId: string, id: string, tx?: TransactionContext): Promise<unknown>;
}
