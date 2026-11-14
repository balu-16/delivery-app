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

/** Signed variant for ledger deltas ("-15000" → -150). */
export function signedPaiseToRupees(paise: string | number | null | undefined): number {
  return Math.trunc(paiseToRupees(paise) * 100) / 100
}

/** Reconcile signed rupees back to a paise string (keeps the leading '-'). */
export function signedRupeesToPaise(rupees: number): string {
  const p = Math.round(rupees * 100)
  return String(p)
}
