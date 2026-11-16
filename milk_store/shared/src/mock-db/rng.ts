// Deterministic PRNG so the seeded dataset is stable across reloads.
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type RNG = () => number

export const int = (rng: RNG, min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min
export const float = (rng: RNG, min: number, max: number) => rng() * (max - min) + min
export const pick = <T,>(rng: RNG, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
export const chance = (rng: RNG, p: number) => rng() < p

export function shuffle<T>(rng: RNG, arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}
