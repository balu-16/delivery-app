export interface SubstitutionCandidate {
  variantId: string;
  candidateVariantId: string;
}

/**
 * v1 rule-based substitution: the candidate must be listed for the expected
 * variant, the feature flag must be on, and the whole line is replaced in the
 * expected quantity (the customer's charge is capped through the P6
 * adjustment port, never above the original price).
 */
export function assertSubstitutionAllowed(
  autoSubstitution: boolean,
  expectedVariantId: string,
  candidateVariantId: string,
  candidates: readonly SubstitutionCandidate[],
): void {
  if (!autoSubstitution) throw new Error('SUBSTITUTION_DISABLED');
  if (candidateVariantId === expectedVariantId) throw new Error('SUBSTITUTION_NOT_PERMITTED');
  const listed = candidates.some(
    (c) => c.variantId === expectedVariantId && c.candidateVariantId === candidateVariantId,
  );
  if (!listed) throw new Error('SUBSTITUTION_NOT_PERMITTED');
}
