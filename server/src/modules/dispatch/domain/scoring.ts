export interface ScoreWeights {
  eta: number;
  idle: number;
  acceptance: number;
}

export interface CandidateScoreInput {
  riderId: string;
  /** Seconds for the rider to reach the store (matrix or haversine estimate). */
  etaToStoreSeconds: number;
  /** Seconds idle (no active task); freshness/fairness signal. */
  idleSeconds: number | null;
  /** Acceptance rate in [0,1]; null when the rider has no offer history yet. */
  acceptanceRate: number | null;
}

export interface ScoredCandidate {
  riderId: string;
  score: number;
}

/** Fixed neutral weights; app_config may override via DispatchSettings. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { eta: 0.6, idle: 0.25, acceptance: 0.15 };

/** Normalisation caps: beyond these every candidate is equally (un)attractive. */
export const SCORE_NORMALISATION = {
  etaSeconds: 900,
  idleSeconds: 1800,
} as const;

/**
 * Pure dispatch scoring (23.2.3): lower ETA to store, longer idle time
 * (fairness) and higher acceptance rate score better. Deterministic; ties
 * break by rider id ascending so repeated runs choose the same rider.
 */
export function scoreCandidates(
  candidates: readonly CandidateScoreInput[],
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): ScoredCandidate[] {
  const etaWeight = clampWeight(weights.eta);
  const idleWeight = clampWeight(weights.idle);
  const acceptanceWeight = clampWeight(weights.acceptance);
  const totalWeight = etaWeight + idleWeight + acceptanceWeight || 1;
  const scored = candidates.map((candidate) => {
    const etaPenalty =
      Math.min(candidate.etaToStoreSeconds, SCORE_NORMALISATION.etaSeconds) /
      SCORE_NORMALISATION.etaSeconds;
    const idleBonus =
      Math.min(candidate.idleSeconds ?? 0, SCORE_NORMALISATION.idleSeconds) /
      SCORE_NORMALISATION.idleSeconds;
    const acceptance = candidate.acceptanceRate ?? 0.5;
    const score =
      (etaWeight * (1 - etaPenalty) + idleWeight * idleBonus + acceptanceWeight * acceptance) /
      totalWeight;
    return { riderId: candidate.riderId, score };
  });
  return scored.sort(
    (a, b) => b.score - a.score || (a.riderId < b.riderId ? -1 : a.riderId > b.riderId ? 1 : 0),
  );
}

function clampWeight(weight: number): number {
  return Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 1) : 0;
}

/**
 * Sequential offers (23.2.5): exactly one live offer per task; the next
 * candidate list is the scored order after excluding declined/cooled riders.
 */
export function nextOfferCandidate(
  scored: readonly ScoredCandidate[],
  excluded: ReadonlySet<string>,
): ScoredCandidate | null {
  for (const candidate of scored) if (!excluded.has(candidate.riderId)) return candidate;
  return null;
}
