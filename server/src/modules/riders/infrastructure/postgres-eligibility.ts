import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type {
  EligibilityRejection,
  EligibilityResult,
  RiderEligibility,
} from '../contracts/riders.js';
import { hasTaskCapacity, isLocationFresh, passesCashLimit } from '../domain/policy.js';
import type { RiderSettings } from './settings.js';

interface CandidateRow {
  rider_id: string;
  profile_status: string;
  user_status: string;
  online: boolean;
  on_break: boolean;
  last_location_at: Date | null;
  active_tasks: number;
}

/**
 * Batch eligibility revalidation under rider status row locks (D22/ADD-17):
 * approval (P1 profile), account state, online flag, location freshness and
 * task capacity are authoritative DB state; Redis GEO membership alone never
 * qualifies a candidate. COD candidates additionally check the cash limit.
 */
export class PostgresRiderEligibility implements RiderEligibility {
  constructor(
    private readonly db: Database,
    private readonly settings: RiderSettings,
  ) {}

  async eligibleForDispatch(input: {
    riderIds: readonly string[];
    at: Date;
    codAmountPaise?: string;
  }): Promise<Record<string, EligibilityResult>> {
    if (!input.riderIds.length) return {};
    const maxTasks = await this.settings.number('riderMaxConcurrentTasks');
    const staleSeconds = await this.settings.number('riderStaleLocationSeconds');
    const cashLimit = await this.settings.paise('cashInHandLimitPaise');
    const ids = [...input.riderIds].sort(); // deterministic lock order
    const rows =
      await sql<CandidateRow>`SELECT s.rider_id,p.status AS profile_status,u.status AS user_status,s.online,s.on_break,s.last_location_at,s.active_tasks
      FROM rider_status s
      JOIN rider_profiles p ON p.user_id=s.rider_id
      JOIN users u ON u.id=s.rider_id
      WHERE s.rider_id=ANY(${ids}::uuid[])
      ORDER BY s.rider_id FOR UPDATE OF s`.execute(this.db);
    let heldByRider: Map<string, bigint> | null = null;
    if (input.codAmountPaise) {
      const held = await sql<{
        rider_id: string;
        balance_after: string;
      }>`SELECT DISTINCT ON (rider_id) rider_id,balance_after FROM rider_cash_ledger
        WHERE rider_id=ANY(${ids}::uuid[]) ORDER BY rider_id, created_at DESC, id DESC`.execute(
        this.db,
      );
      heldByRider = new Map(held.rows.map((row) => [row.rider_id, BigInt(row.balance_after)]));
    }
    const results: Record<string, EligibilityResult> = {};
    const seen = new Set<string>();
    for (const row of rows.rows) {
      seen.add(row.rider_id);
      results[row.rider_id] = evaluate(row, {
        at: input.at,
        maxTasks,
        staleSeconds,
        codAmountPaise: input.codAmountPaise,
        cashHeld: heldByRider?.get(row.rider_id) ?? null,
        cashLimit,
      });
    }
    for (const riderId of input.riderIds)
      if (!seen.has(riderId)) results[riderId] = { eligible: false, reason: 'NOT_APPROVED' };
    return results;
  }
}

function evaluate(
  row: CandidateRow,
  limits: {
    at: Date;
    maxTasks: number;
    staleSeconds: number;
    codAmountPaise?: string;
    cashHeld: bigint | null;
    cashLimit: string;
  },
): { eligible: boolean; reason?: EligibilityRejection } {
  if (row.user_status !== 'ACTIVE') return { eligible: false, reason: 'NOT_APPROVED' };
  if (row.profile_status === 'SUSPENDED') return { eligible: false, reason: 'SUSPENDED' };
  if (row.profile_status !== 'APPROVED') return { eligible: false, reason: 'NOT_APPROVED' };
  if (!row.online) return { eligible: false, reason: 'OFFLINE' };
  if (row.on_break) return { eligible: false, reason: 'ON_BREAK' };
  if (!isLocationFresh(row.last_location_at, limits.at, limits.staleSeconds))
    return { eligible: false, reason: 'STALE_LOCATION' };
  if (!hasTaskCapacity(row.active_tasks, limits.maxTasks))
    return { eligible: false, reason: 'AT_TASK_CAPACITY' };
  if (limits.codAmountPaise && limits.cashHeld !== null)
    if (!passesCashLimit(limits.cashHeld, limits.codAmountPaise, limits.cashLimit))
      return { eligible: false, reason: 'CASH_LIMIT' };
  return { eligible: true };
}
