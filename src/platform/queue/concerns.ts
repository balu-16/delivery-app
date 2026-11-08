import type { Json } from '../database/database.js';

export const CONCERNS = [
  'outbox',
  'notifications',
  'dispatch',
  'payments',
  'subscriptions',
  'imports',
  'maintenance',
] as const;
export type QueueConcern = (typeof CONCERNS)[number];
export type ConcernHandler = (data: Json, jobId: string) => Promise<void>;
export type Schedule = { everyMs: number } | { pattern: string };
export interface FailedConcernJob {
  id: string;
  name: string;
  attempts: number;
  failedAt: number | undefined;
}
