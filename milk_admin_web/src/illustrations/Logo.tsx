export function CowMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <g transform="translate(24 25)">
        <ellipse cx="-11" cy="-8" rx="6" ry="4.5" fill="#fff" transform="rotate(-28 -11 -8)" />
        <ellipse cx="11" cy="-8" rx="6" ry="4.5" fill="#fff" transform="rotate(28 11 -8)" />
        <circle cx="-10.5" cy="-8" r="2" fill="#F5A623" />
        <circle cx="10.5" cy="-8" r="2" fill="#F5A623" />
        <path d="M-10 -9 C -12 -20, 12 -20, 10 -9 C 14 -2, 8 8, 0 8 C -8 8, -14 -2, -10 -9 Z" fill="#fff" stroke="#2E7D1A" strokeWidth="2.4" />
        <path d="M-3 -13 C 0 -17, 6 -15, 5 -10 C 8 -7, 6 -1, 2 -2 C -2 -1, -5 -5, -3 -13 Z" fill="#7A4A21" />
        <ellipse cx="0" cy="4.5" rx="7.5" ry="5" fill="#F7C8CF" />
        <circle cx="-3" cy="4" r="1.6" fill="#B05560" />
        <circle cx="3" cy="4" r="1.6" fill="#B05560" />
        <path d="M-1.5 7.5 Q 0 9 1.5 7.5" stroke="#B05560" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 ring-1 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30">
        <CowMark size={30} />
      </div>
      {!compact && (
        <div className="min-w-0">
          <div className="flex items-center whitespace-nowrap text-[19px] font-extrabold leading-none tracking-tight">
            DairyDirect<span className="translate-y-[-6px] text-[9px] font-bold">®</span>
          </div>
          <span className="mt-1.5 inline-block rounded-full bg-brand-100 px-2.5 py-0.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
            Admin Portal
          </span>
        </div>
      )}
    </div>
  )
}
