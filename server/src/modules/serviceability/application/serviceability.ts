import type {
  ServiceabilityInput,
  ServiceabilityReason,
  ServiceabilityResult,
  ServiceabilityTransaction,
  ZoneSnapshot,
} from '../contracts/serviceability.js';
import { validateIndiaPoint } from '../domain/point.js';

export interface Candidate {
  zone: ZoneSnapshot;
  status: 'ONLINE' | 'OFFLINE' | 'PAUSED';
  open: boolean;
  capacityRemaining: boolean;
  noRidersAvailable: boolean;
}
export interface ServiceabilityRepository {
  findCandidate(
    input: ServiceabilityInput,
    tx?: ServiceabilityTransaction,
  ): Promise<Candidate | null>;
}
export interface EtaSettings {
  minMinutes: number;
  maxMinutes: number;
}
export class ServiceabilityQuery {
  constructor(
    private readonly repository: ServiceabilityRepository,
    private readonly eta: (tx?: ServiceabilityTransaction) => Promise<EtaSettings>,
  ) {}
  async check(
    input: ServiceabilityInput,
    tx?: ServiceabilityTransaction,
  ): Promise<ServiceabilityResult> {
    validateIndiaPoint(input);
    if (!Number.isFinite(input.targetTime.getTime())) throw new Error('INVALID_TARGET_TIME');
    const candidate = await this.repository.findCandidate(input, tx);
    if (!candidate)
      return {
        serviceable: false,
        storeId: null,
        zone: null,
        etaRange: null,
        reasons: ['OUTSIDE_ZONE'],
      };
    const reasons: ServiceabilityReason[] = [];
    if (candidate.status === 'PAUSED') reasons.push('STORE_PAUSED');
    if (candidate.status === 'OFFLINE' || !candidate.open) reasons.push('STORE_CLOSED');
    if (!candidate.capacityRemaining) reasons.push('STORE_AT_CAPACITY');
    if (candidate.noRidersAvailable) reasons.push('NO_RIDERS_AVAILABLE');
    const eta = reasons.length === 0 ? await this.eta(tx) : null;
    if (
      eta &&
      (!Number.isFinite(eta.minMinutes) ||
        !Number.isFinite(eta.maxMinutes) ||
        eta.minMinutes < 0 ||
        eta.maxMinutes < eta.minMinutes)
    )
      throw new Error('INVALID_ETA_CONFIG');
    return {
      serviceable: reasons.length === 0,
      storeId: candidate.zone.storeId,
      zone: candidate.zone,
      etaRange: eta,
      reasons,
    };
  }
}
