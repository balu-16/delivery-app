/**
 * Handover codes are derived with a versioned keyed HMAC over the order id and
 * never stored as plaintext (D20-style); only the verifier and key version are
 * persisted. P8 rider custody consumes `presentCode` when building delivery
 * tasks; P7 owns the store-side verification surface.
 */
export interface HandoverIssueInput {
  orderId: string;
  storeId: string;
}

export const HANDOVER_CODES = Symbol('HANDOVER_CODES');
export interface HandoverCodes {
  /** Derive the code and persist only its HMAC verifier (idempotent per order). */
  issue(input: HandoverIssueInput): Promise<{ state: 'PENDING' }>;
  /** Authorized read of the derived code for the assigned rider surface (P8). */
  presentCode(orderId: string): Promise<{ code: string; keyVersion: number }>;
  /** Store-side verification: attempt-limited, lockout aware; audited manager override. */
  verify(
    actorId: string,
    input: {
      orderId: string;
      code?: string;
      /** Manager override requires a reason and is recorded as OVERRIDE. */
      override?: boolean;
      reason?: string;
    },
  ): Promise<{ state: 'VERIFIED' | 'OVERRIDE' }>;
}

export interface PackInput {
  bags: string;
  sealCode: string;
  coldChain: boolean;
}

export const PICK_PACKING = Symbol('PICK_PACKING');
export interface PickPacking {
  /** Records bags/seal/cold-chain and marks the order packed through P6. */
  pack(
    actorId: string,
    orderId: string,
    input: PackInput,
    reference: string,
  ): Promise<{ packedAt: string }>;
}
