// Friendly flat-style SVG avatars — 12 deterministic variants, no real photos.
const SKIN = ['#F2C7A4', '#E8B48B', '#D89B6E', '#C98A5E', '#F5D0AE', '#B87A50']
const HAIR = ['#2B2118', '#4A3221', '#151312', '#6B4423', '#8C5A2B', '#1F1B18']
const BG = ['#E7F4DC', '#FDF1DC', '#E3F0FA', '#FBE7E7', '#EEE7FA', '#E4F5F0']
const SHIRT = ['#2E7D1A', '#3B9DF0', '#F5A623', '#8B5CF6', '#E5484D', '#0E9F8A']

export function Avatar({ index, name, size = 36, className }: { index: number; name?: string; size?: number; className?: string }) {
  const i = ((index % 12) + 12) % 12
  const skin = SKIN[i % SKIN.length]!
  const hair = HAIR[(i * 3) % HAIR.length]!
  const bg = BG[i % BG.length]!
  const shirt = SHIRT[(i * 5) % SHIRT.length]!
  const female = i % 3 === 1
  const longHair = i % 4 === 1
  const beard = !female && i % 5 === 2
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48" aria-label={name ?? 'avatar'} role="img"
      className={className}
    >
      <rect width="48" height="48" rx="24" fill={bg} />
      {female && <circle cx="24" cy="22" r="15" fill={hair} />}
      {/* shoulders */}
      <path d="M8 48 C 10 37, 38 37, 40 48 Z" fill={shirt} />
      {/* head */}
      <circle cx="24" cy="21" r="11.5" fill={skin} />
      {/* hair */}
      {female ? (
        <>
          <path d="M12.5 22 C 11 9, 37 9, 35.5 22 C 33 15, 15 15, 12.5 22 Z" fill={hair} />
          {longHair && <path d="M12 20 C 10 34, 14 38, 15 36 C 14 30, 14 24, 14.5 21 Z" fill={hair} />}
          {longHair && <path d="M36 20 C 38 34, 34 38, 33 36 C 34 30, 34 24, 33.5 21 Z" fill={hair} />}
        </>
      ) : (
        <path d="M13 19 C 13 10, 35 10, 35 19 C 30 14.5, 18 14.5, 13 19 Z" fill={hair} />
      )}
      {/* eyes + smile */}
      <circle cx="19.5" cy="21.5" r="1.5" fill="#2B2118" />
      <circle cx="28.5" cy="21.5" r="1.5" fill="#2B2118" />
      <path d="M20 27 Q 24 30.4 28 27" stroke="#2B2118" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {beard && <path d="M17 25.5 C 18 33, 30 33, 31 25.5 C 28 28.5, 20 28.5, 17 25.5 Z" fill={hair} opacity="0.85" />}
    </svg>
  )
}

export function InitialAvatar({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  const hues = ['#E7F4DC', '#FDF1DC', '#E3F0FA', '#FBE7E7', '#EEE7FA', '#E4F5F0']
  const inks = ['#2E7D1A', '#B47616', '#2670B8', '#C23B3B', '#6D46C0', '#0E8A76']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997
  const i = h % hues.length
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${className ?? ''}`}
      style={{ width: size, height: size, background: hues[i], color: inks[i], fontSize: size * 0.36 }}
      aria-label={name}
    >
      {initials}
    </div>
  )
}
