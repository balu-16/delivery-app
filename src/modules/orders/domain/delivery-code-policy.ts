/**
 * Delivery code policy (D20): a four-digit code derived with a versioned
 * secret and an order nonce. Only the HMAC verifier and key version are
 * stored; derivation and verification use separate derived keys; attempts
 * are bounded and lock the verifier after the configured tries. The crypto
 * primitives live in infrastructure (pure domain has no I/O or crypto).
 */
export const CODE_LENGTH = 4;

/** Verifier input is the presented code, never stored in plaintext. */
export function codeFromNonce(digest: Buffer): string {
  const value = digest.readUInt32BE(0) % 10_000;
  return value.toString().padStart(CODE_LENGTH, '0');
}
