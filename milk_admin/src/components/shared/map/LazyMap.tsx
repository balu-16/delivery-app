import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { MapInnerProps } from './MapInner'

// The heavy chunk: react-leaflet + leaflet + CSS live here and only here.
const MapChunk = lazy(() => import('./MapInner'))

/**
 * Maps load only when scrolled into view AND only then fetch the leaflet chunk.
 * Renders a layout-stable placeholder before that (zero CLS, zero initial cost).
 */
export function LazyMap(props: MapInnerProps & { className?: string }) {
  const { className, ...mapProps } = props
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || inView) return
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setInView(true); io.disconnect() } },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView])

  return (
    <div ref={ref} className={className ?? 'h-full w-full'}>
      {inView ? (
        <Suspense fallback={<MapSkeleton />}>
          <MapChunk {...mapProps} />
        </Suspense>
      ) : (
        <MapSkeleton />
      )}
    </div>
  )
}

function MapSkeleton() {
  return (
    <div className="skeleton h-full w-full rounded-[14px]" aria-label="Loading map" />
  )
}
