import {
  nextOfferCandidate,
  scoreCandidates,
  type CandidateScoreInput,
} from '../../../src/modules/dispatch/domain/scoring.js';

function candidate(
  riderId: string,
  overrides: Partial<Omit<CandidateScoreInput, 'riderId'>> = {},
): CandidateScoreInput {
  return {
    riderId,
    etaToStoreSeconds: 120,
    idleSeconds: 0,
    acceptanceRate: null,
    ...overrides,
  };
}

describe('dispatch scoring (pure)', () => {
  test('lower ETA to the store scores better', () => {
    const fast = scoreCandidates([candidate('r-fast', { etaToStoreSeconds: 60 })])[0]!;
    const slow = scoreCandidates([candidate('r-slow', { etaToStoreSeconds: 600 })])[0]!;
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  test('longer idle time (fairness) scores better at equal ETA', () => {
    const idle = scoreCandidates([candidate('r-idle', { idleSeconds: 1800 })])[0]!;
    const fresh = scoreCandidates([candidate('r-fresh', { idleSeconds: 0 })])[0]!;
    expect(idle.score).toBeGreaterThan(fresh.score);
  });

  test('higher acceptance rate scores better at equal other inputs', () => {
    const reliable = scoreCandidates([candidate('r-good', { acceptanceRate: 0.95 })])[0]!;
    const flaky = scoreCandidates([candidate('r-bad', { acceptanceRate: 0.1 })])[0]!;
    expect(reliable.score).toBeGreaterThan(flaky.score);
  });

  test('unknown acceptance history uses the neutral prior', () => {
    const unknown = scoreCandidates([candidate('r-new', { acceptanceRate: null })])[0]!;
    const neutral = scoreCandidates([candidate('r-mid', { acceptanceRate: 0.5 })])[0]!;
    expect(unknown.score).toBeCloseTo(neutral.score, 10);
  });

  test('scores are deterministic and ties break by rider id ascending', () => {
    const input = [candidate('r-b'), candidate('r-a')];
    const first = scoreCandidates(input);
    const second = scoreCandidates([...input].reverse());
    expect(first.map((entry) => entry.riderId)).toEqual(['r-a', 'r-b']);
    expect(second.map((entry) => entry.riderId)).toEqual(['r-a', 'r-b']);
    expect(first[0]!.score).toBeCloseTo(second[0]!.score, 12);
  });

  test('normalisation caps extreme inputs so distant riders stay selectable', () => {
    const capped = scoreCandidates([candidate('r-far', { etaToStoreSeconds: 99999 })])[0]!;
    const atCap = scoreCandidates([candidate('r-cap', { etaToStoreSeconds: 900 })])[0]!;
    expect(capped.score).toBeCloseTo(atCap.score, 10);
  });

  test('nextOfferCandidate skips excluded riders in score order', () => {
    const scored = scoreCandidates([candidate('r-1'), candidate('r-2'), candidate('r-3')]);
    expect(nextOfferCandidate(scored, new Set([scored[0]!.riderId]))?.riderId).toBe(
      scored[1]!.riderId,
    );
    expect(nextOfferCandidate(scored, new Set(scored.map((entry) => entry.riderId)))).toBeNull();
  });
});
