import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnimation, useReducedMotion } from 'framer-motion'

/** Detect platform for the ⌘K vs Ctrl+K hint. */
export function useOS(): 'mac' | 'other' {
  return useMemo(() => {
    if (typeof navigator === 'undefined') return 'other'
    return /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'mac' : 'other'
  }, [])
}

/** Debounce any fast-changing value (search inputs) — default 250 ms. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

/** Count-up animation for KPI values; respects reduced motion. */
export function useCountUp(value: number, duration = 0.7) {
  const reduced = useReducedMotion()
  const [display, setDisplay] = useState(reduced ? value : 0)
  const prev = useRef(value)
  useEffect(() => {
    if (reduced) { setDisplay(value); return }
    const controls = useAnimationScope(prev.current, value, duration, setDisplay)
    prev.current = value
    return () => controls.stop()
  }, [value, duration, reduced])
  return display
}

// tiny rAF tween without pulling framer's animate into the hook graph
function useAnimationScope(from: number, to: number, duration: number, set: (v: number) => void) {
  const start = performance.now()
  let raf = 0
  const tick = (t: number) => {
    const p = Math.min(1, (t - start) / (duration * 1000))
    const eased = 1 - Math.pow(1 - p, 3)
    set(from + (to - from) * eased)
    if (p < 1) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return { stop: () => cancelAnimationFrame(raf) }
}

/** Stagger helper for route content cascades. */
export function useStagger() {
  const reduced = useReducedMotion()
  return {
    container: {
      hidden: {},
      show: { transition: { staggerChildren: reduced ? 0 : 0.05 } },
    },
    item: {
      hidden: { opacity: 0, y: 14 },
      show: { opacity: 1, y: 0, transition: { duration: 0.38, ease: [0.22, 1, 0.36, 1] as const } },
    },
  }
}

export { useAnimation }
