// ── Money helpers: backend money values are paise STRINGS ────────────────────
// Integer-safe conversion only — never float math on currency.

/** "42000" → 420 (rupees). Accepts paise strings or numbers; non-finite input → 0. */
export function paiseToRupees(paise: string | number | null | undefined): number {
  if (paise === null || paise === undefined) return 0
  const n = typeof paise === 'string' ? Number(paise) : paise
  if (!Number.isFinite(n)) return 0
  return Number(n) / 100
}

/** 420.5 → "42050" (paise string). Rounds to the nearest paisa. */
export function rupeesToPaise(rupees: number): string {
  const p = Math.round(rupees * 100)
  return String(Math.max(0, p))
}

/**
 * Exact decimal-string rupees → paise string (customize2 §3B): parses the
 * string without float math, accepts "0", and rejects malformed input with
 * an Error. "1" → "100", "0.01" → "1", "10.99" → "1099".
 */
export function rupeesStringToPaise(rupees: string): string {
  const trimmed = rupees.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) throw new Error('INVALID_AMOUNT')
  const [whole, frac = ''] = trimmed.split('.')
  const paise = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))
  return paise.toString()
}

/** "42000" paise string → "420.00" rupees string (display). */
export function paiseToRupeesString(paise: string): string {
  const n = BigInt(paise)
  return `${(n / 100n).toString()}.${(n % 100n).toString().padStart(2, '0')}`
}

/** Signed variant for ledger deltas ("-15000" → -150). */
export function signedPaiseToRupees(paise: string | number | null | undefined): number {
  return Math.trunc(paiseToRupees(paise) * 100) / 100
}

/** Reconcile signed rupees back to a paise string (keeps the leading '-'). */
export function signedRupeesToPaise(rupees: number): string {
  const p = Math.round(rupees * 100)
  return String(p)
}
