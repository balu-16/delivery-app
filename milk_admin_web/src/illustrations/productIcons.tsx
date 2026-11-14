import type { ProductIcon } from '@/types'

// Small flat product icons used in order lines, product rows and category legends.
export function ProductGlyph({ icon, size = 22 }: { icon: ProductIcon; size?: number }) {
  const s = size
  switch (icon) {
    case 'milk':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M9 3h6v2l1.5 3v12.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V8L9 5V3z" fill="#fff" stroke="#B9CDB4" strokeWidth="1" />
          <path d="M9.6 10h4.8l.2 9H9.4l.2-9z" fill="#EDF6E8" />
          <rect x="9" y="3" width="6" height="2.4" rx="0.8" fill="#2E7D1A" />
          <circle cx="12" cy="14" r="2.2" fill="#2E7D1A" opacity="0.85" />
        </svg>
      )
    case 'paneer':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <rect x="4" y="7" width="13" height="11" rx="2" fill="#FDFCF7" stroke="#D8CDB6" strokeWidth="1" />
          <rect x="17" y="10" width="4" height="8" rx="1.5" fill="#F3EEDD" />
          <circle cx="8" cy="11" r="1.1" fill="#E7DCC0" />
          <circle cx="12" cy="14.5" r="1.1" fill="#E7DCC0" />
        </svg>
      )
    case 'ghee':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <rect x="5" y="7" width="14" height="14" rx="2.5" fill="#F5A623" opacity="0.9" />
          <rect x="8" y="3.5" width="8" height="4" rx="1.4" fill="#7A4A21" />
          <rect x="7" y="10.5" width="10" height="6" rx="1.2" fill="#FBE7C0" />
        </svg>
      )
    case 'curd':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M4 11h16c0 5-3 8.5-8 8.5S4 16 4 11z" fill="#FDFCF7" stroke="#D8CDB6" strokeWidth="1" />
          <ellipse cx="12" cy="11" rx="8" ry="2.2" fill="#F3EEDD" />
          <ellipse cx="12" cy="10.6" rx="5.5" ry="1.4" fill="#EAF3E2" />
        </svg>
      )
    case 'butter':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <rect x="4" y="10" width="16" height="8" rx="2" fill="#F5C242" />
          <rect x="4" y="10" width="16" height="3" rx="1.4" fill="#FBDF9A" />
        </svg>
      )
    case 'lassi':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M7 5h10l-1.4 13.2a2 2 0 0 1-2 1.8h-3.2a2 2 0 0 1-2-1.8L7 5z" fill="#FDF8EC" stroke="#D8CDB6" strokeWidth="1" />
          <rect x="8.4" y="9" width="7.2" height="9" rx="1.6" fill="#F7EBD2" />
        </svg>
      )
    case 'buttermilk':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M8 4h8l1.2 3.2-1 13a1.6 1.6 0 0 1-1.6 1.5H9.4A1.6 1.6 0 0 1 7.8 20l-1-13L8 4z" fill="#EAF3E2" stroke="#B9CDB4" strokeWidth="1" />
          <rect x="9.6" y="10" width="4.8" height="6" rx="1" fill="#2E7D1A" opacity="0.35" />
        </svg>
      )
    case 'cream':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <rect x="6" y="6" width="12" height="14" rx="2" fill="#FDFCF7" stroke="#D8CDB6" strokeWidth="1" />
          <rect x="6" y="6" width="12" height="4" rx="1.6" fill="#F5A623" opacity="0.85" />
        </svg>
      )
    case 'cheese':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M3 16 18 7c2 1 3 3.4 3 5.4V16H3z" fill="#F5C242" />
          <circle cx="12" cy="13" r="1.4" fill="#FBDF9A" />
          <circle cx="17" cy="12" r="1.1" fill="#FBDF9A" />
        </svg>
      )
    case 'khoya':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <ellipse cx="12" cy="13" rx="8" ry="6.4" fill="#F6EFDD" />
          <ellipse cx="10" cy="11" rx="3.4" ry="2.2" fill="#FDF9EF" />
        </svg>
      )
    case 'flavored_milk':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M9 3h6v2l1.5 3v12.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V8L9 5V3z" fill="#FBE7EE" stroke="#E5B7C6" strokeWidth="1" />
          <rect x="9" y="3" width="6" height="2.4" rx="0.8" fill="#C23B7A" />
          <path d="M9.4 10h5.2l.2 9H9.2l.2-9z" fill="#F6CFDD" />
        </svg>
      )
    default:
      return <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#D8E8CF" /></svg>
  }
}

/** Product glyph inside the soft tinted tile used across tables/drawers. */
export function ProductTile({ icon, size = 34 }: { icon: ProductIcon; size?: number }) {
  return (
    <div className="grid shrink-0 place-items-center rounded-xl bg-brand-50 ring-1 ring-brand-100 dark:bg-brand-500/10 dark:ring-brand-500/20" style={{ width: size, height: size }}>
      <ProductGlyph icon={icon} size={size * 0.6} />
    </div>
  )
}
