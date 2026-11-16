/** Layout-stable route fallback (no spinners — shimmer only, no layout shift). */
export function RouteFallback() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading page">
      <div className="skeleton h-9 w-64 rounded-xl" />
      <div className="skeleton h-4 w-80 rounded-lg" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-[110px] rounded-card" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="skeleton h-[300px] rounded-card lg:col-span-6" />
        <div className="skeleton h-[300px] rounded-card lg:col-span-3" />
        <div className="skeleton h-[300px] rounded-card lg:col-span-3" />
      </div>
    </div>
  )
}
