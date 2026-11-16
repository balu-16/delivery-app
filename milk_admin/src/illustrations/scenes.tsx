import { motion } from 'framer-motion'
import { CowMark } from './Logo'

/* Shared bits ────────────────────────────────────────────────── */
function Cloud({ x, y, scale = 1, dur = 30 }: { x: number; y: number; scale?: number; dur?: number }) {
  return (
    <g className="animate-drift" style={{ animationDuration: `${dur}s` }} transform={`translate(${x} ${y}) scale(${scale})`}>
      <g opacity="0.9">
        <ellipse cx="0" cy="0" rx="26" ry="10" fill="#fff" />
        <ellipse cx="16" cy="-6" rx="14" ry="8" fill="#fff" />
        <ellipse cx="-16" cy="-4" rx="12" ry="7" fill="#fff" />
      </g>
    </g>
  )
}

function Tree({ x, y, scale = 1, hue = '#4C9E2F' }: { x: number; y: number; scale?: number; hue?: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="animate-sway" style={{ transformOrigin: '0px 0px' }}>
        <rect x="-2" y="0" width="4" height="14" rx="2" fill="#8B5E3C" />
        <circle cx="0" cy="-8" r="12" fill={hue} />
        <circle cx="-8" cy="-2" r="8" fill={hue} opacity="0.9" />
        <circle cx="8" cy="-2" r="8" fill={hue} opacity="0.9" />
      </g>
    </g>
  )
}

function Cow({ x, y, scale = 1, flip = false, dur = 3.4 }: { x: number; y: number; scale?: number; flip?: boolean; dur?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
      <g className="animate-bob" style={{ animationDuration: `${dur}s` }}>
        <ellipse cx="0" cy="12" rx="24" ry="4" fill="#3F6212" opacity="0.12" />
        <rect x="-18" y="-8" width="34" height="18" rx="9" fill="#fff" />
        <rect x="-18" y="-8" width="34" height="18" rx="9" fill="url(#cowPatch)" opacity="0.85" />
        <rect x="12" y="-6" width="10" height="8" rx="4" fill="#fff" />
        <circle cx="20" cy="-3" r="1.4" fill="#2B2118" />
        <ellipse cx="16.5" cy="0" rx="3.4" ry="2.4" fill="#F7C8CF" />
        <path d="M-18 0 q-8 2 -9 9" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" className="animate-sway" style={{ transformOrigin: '-18px 0px' }} />
        <rect x="-14" y="9" width="5" height="9" rx="2.5" fill="#E7DFD3" />
        <rect x="8" y="9" width="5" height="9" rx="2.5" fill="#E7DFD3" />
        <rect x="-4" y="9" width="5" height="9" rx="2.5" fill="#E7DFD3" />
        <rect x="14" y="9" width="5" height="9" rx="2.5" fill="#E7DFD3" />
        <circle cx="-6" cy="-16" r="3" fill="#fff" />
        <circle cx="-2" cy="-17" r="2.4" fill="#fff" />
      </g>
    </g>
  )
}

/* ── Meadow scene (Dashboard / Stores / Reports / Settings / Payments headers) ── */
export function MeadowScene({ className, variant = 'dashboard' }: { className?: string; variant?: 'dashboard' | 'stores' | 'reports' | 'settings' | 'payments' }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <defs>
        <linearGradient id="meadowSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#EAF6F0" />
          <stop offset="100%" stopColor="#F7FBF2" />
        </linearGradient>
        <linearGradient id="meadowHill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#BFE3A0" />
          <stop offset="100%" stopColor="#9BCF76" />
        </linearGradient>
        <radialGradient id="sunGlow">
          <stop offset="0%" stopColor="#FFE9A8" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#FFE9A8" stopOpacity="0" />
        </radialGradient>
        <pattern id="cowPatch" width="26" height="22" patternUnits="userSpaceOnUse">
          <ellipse cx="8" cy="7" rx="5" ry="4" fill="#3D3128" opacity="0.7" />
          <ellipse cx="20" cy="14" rx="4" ry="3" fill="#3D3128" opacity="0.6" />
        </pattern>
      </defs>
      <rect width="520" height="160" fill="url(#meadowSky)" rx="18" />
      <circle className="animate-pulse-soft" cx="452" cy="34" r="34" fill="url(#sunGlow)" />
      <circle cx="452" cy="34" r="16" fill="#FFD978" />
      <Cloud x={80} y={30} scale={0.9} dur={34} />
      <Cloud x={300} y={22} scale={0.7} dur={26} />
      <path d="M0 118 Q 90 78 200 112 T 520 108 V160 H0 Z" fill="url(#meadowHill)" />
      <path d="M0 132 Q 140 100 300 130 T 520 124 V160 H0 Z" fill="#8CC25C" />
      {/* windmill */}
      <g transform="translate(468 96)">
        <rect x="-2.5" y="-26" width="5" height="30" rx="2" fill="#E7E2D6" />
        <g className="animate-spin-slow" style={{ animationDuration: '6s', transformOrigin: '0px -26px' }}>
          <path d="M0 -26 L0 -44" stroke="#F5F2EA" strokeWidth="3.4" strokeLinecap="round" />
          <path d="M0 -26 L15 -17" stroke="#F5F2EA" strokeWidth="3.4" strokeLinecap="round" />
          <path d="M0 -26 L-15 -17" stroke="#F5F2EA" strokeWidth="3.4" strokeLinecap="round" />
        </g>
      </g>
      {/* silo + barn */}
      <g transform="translate(310 76)">
        <rect x="44" y="4" width="26" height="40" rx="6" fill="#D9E4D2" />
        <ellipse cx="57" cy="6" rx="13" ry="7" fill="#B9C9B0" />
        <rect x="0" y="10" width="42" height="34" rx="4" fill="#C23B3B" />
        <path d="M-3 10 L21 -6 L45 10 Z" fill="#9E2F2F" />
        <rect x="15" y="24" width="12" height="20" rx="2" fill="#7A4A21" />
        <g transform="translate(6 14)">
          <rect width="14" height="8" rx="1.5" fill="#2B6CB0" opacity="0.9" />
          <rect x="16" width="14" height="8" rx="1.5" fill="#2B6CB0" opacity="0.75" />
        </g>
      </g>
      <Tree x={90} y={112} scale={0.9} />
      <Tree x={130} y={104} scale={0.62} hue="#5FA83B" />
      <Tree x={392} y={108} scale={0.8} />
      {/* fence */}
      <g stroke="#E7DFD3" strokeWidth="3" strokeLinecap="round">
        <path d="M20 138 v14 M44 138 v14 M68 138 v14" />
        <path d="M16 142 h56 M16 148 h56" strokeWidth="2.4" />
      </g>
      <Cow x={190} y={132} scale={0.9} />
      <Cow x={258} y={138} scale={0.72} flip dur={4.1} />
      {variant === 'stores' && <Cow x={330} y={142} scale={0.6} />}
      <rect x="0" y="150" width="520" height="10" fill="#7FB551" />
    </svg>
  )
}

/* ── Delivery scooter scene (Orders / Delivery headers) ─────────── */
export function ScooterScene({ className, moving = true }: { className?: string; moving?: boolean }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <defs>
        <linearGradient id="scootSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#EAF3FA" />
          <stop offset="100%" stopColor="#F5FAF3" />
        </linearGradient>
      </defs>
      <rect width="520" height="160" fill="url(#scootSky)" rx="18" />
      {/* skyline */}
      <g fill="#CFE3D2" opacity="0.85">
        <rect x="360" y="52" width="34" height="66" rx="3" />
        <rect x="402" y="38" width="26" height="80" rx="3" />
        <rect x="436" y="60" width="30" height="58" rx="3" />
        <rect x="474" y="46" width="22" height="72" rx="3" />
      </g>
      <g fill="#B9D4BC" opacity="0.9">
        <rect x="368" y="62" width="6" height="6" /><rect x="380" y="62" width="6" height="6" />
        <rect x="410" y="50" width="6" height="6" /><rect x="420" y="50" width="6" height="6" />
        <rect x="444" y="72" width="6" height="6" /><rect x="456" y="72" width="6" height="6" />
        <rect x="480" y="58" width="6" height="6" />
      </g>
      <Cloud x={90} y={26} scale={0.8} dur={30} />
      <Cloud x={260} y={18} scale={0.6} dur={24} />
      <Tree x={330} y={110} scale={0.85} />
      <Tree x={40} y={112} scale={0.7} hue="#5FA83B" />
      {/* road */}
      <path d="M0 138 Q 160 118 300 134 T 520 130" stroke="#AFC98F" strokeWidth="10" fill="none" strokeLinecap="round" />
      <path d="M0 138 Q 160 118 300 134 T 520 130" stroke="#fff" strokeWidth="1.6" fill="none" strokeDasharray="10 12" className={moving ? 'animate-drift' : ''} style={{ animationDuration: '5s' }} opacity="0.8" />
      {/* pin */}
      <g transform="translate(468 78)">
        <g className="animate-bounce-pin">
          <path d="M0 0 C -10 -14, -10 -30, 0 -30 C 10 -30, 10 -14, 0 0 Z" fill="#E5484D" />
          <circle cx="0" cy="-22" r="5" fill="#fff" />
        </g>
        <ellipse cx="0" cy="4" rx="8" ry="2.6" fill="#3F6212" opacity="0.15" />
      </g>
      {/* scooter + rider */}
      <g transform="translate(160 106)">
        <g className="animate-bob">
          <ellipse cx="0" cy="36" rx="42" ry="5" fill="#3F6212" opacity="0.14" />
          <g className="animate-spin-slow" style={{ animationDuration: '0.9s', transformOrigin: '-24px 26px' }}>
            <circle cx="-24" cy="26" r="11" fill="#2B2118" />
            <circle cx="-24" cy="26" r="5" fill="#9C948A" />
            <path d="M-24 16 v20 M-34 26 h20" stroke="#5E564C" strokeWidth="1.6" />
          </g>
          <g className="animate-spin-slow" style={{ animationDuration: '0.9s', transformOrigin: '30px 26px' }}>
            <circle cx="30" cy="26" r="11" fill="#2B2118" />
            <circle cx="30" cy="26" r="5" fill="#9C948A" />
            <path d="M30 16 v20 M20 26 h20" stroke="#5E564C" strokeWidth="1.6" />
          </g>
          <path d="M-24 26 h16 l10 -18 h10 l6 18 h12" stroke="#2E7D1A" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="10" y="-6" width="26" height="18" rx="3.5" fill="#5DAE2B" />
          <rect x="14" y="-2" width="18" height="4" rx="2" fill="#fff" opacity="0.85" />
          <circle cx="40" cy="4" r="3" fill="#FFD978" />
          {/* rider */}
          <circle cx="6" cy="-18" r="8.4" fill="#E8B48B" />
          <path d="M-2 -20 a8.4 8.4 0 0 1 16 -1 l-3 -2 q-6 -3 -10 1 z" fill="#2E7D1A" />
          <rect x="-4" y="-12" width="6" height="16" rx="3" fill="#2E7D1A" />
          <path d="M2 -8 q10 4 16 10" stroke="#2E7D1A" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M0 2 q-2 8 2 14" stroke="#26521B" strokeWidth="7" fill="none" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  )
}

/* ── City scene (Cities header) ─────────────────────────────────── */
export function CityScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g className="animate-floaty" transform="translate(96 20)">
        {/* isometric map tile */}
        <g transform="rotate(-8)">
          <rect x="0" y="26" width="240" height="112" rx="20" fill="#DCEBD4" />
          <rect x="0" y="18" width="240" height="108" rx="20" fill="#EAF4E2" />
          <path d="M40 18 h14 v108 h-14 z M120 18 h12 v108 h-12 z M198 18 h12 v108 h-12 z" fill="#CFE3C2" opacity="0.8" />
          <path d="M0 62 h240 v10 H0 z M0 92 h240 v8 H0 z" fill="#CFE3C2" opacity="0.7" />
          <rect x="52" y="28" width="26" height="20" rx="3" fill="#F4EEDF" />
          <rect x="138" y="30" width="30" height="22" rx="3" fill="#F4EEDF" />
          <rect x="60" y="98" width="30" height="20" rx="3" fill="#F4EEDF" />
          <rect x="152" y="100" width="24" height="18" rx="3" fill="#F4EEDF" />
          <circle cx="206" cy="40" r="6" fill="#7FCB62" />
          <circle cx="96" cy="76" r="6" fill="#7FCB62" />
          <circle cx="176" cy="76" r="7" fill="#F5A623" />
          {/* roads */}
          <path d="M0 66 q80 4 240 0" stroke="#fff" strokeWidth="4" fill="none" />
          {/* truck driving along road */}
          <g className="animate-drift" style={{ animationDuration: '9s' }}>
            <g transform="translate(-30 52)">
              <rect x="0" y="0" width="30" height="14" rx="3" fill="#fff" />
              <rect x="0" y="0" width="12" height="14" rx="3" fill="#5DAE2B" />
              <circle cx="7" cy="15" r="3.4" fill="#2B2118" />
              <circle cx="23" cy="15" r="3.4" fill="#2B2118" />
              <text x="15" y="10" fontSize="7" textAnchor="middle" fill="#fff" fontWeight="700">Dairy</text>
            </g>
          </g>
        </g>
        {/* milk-bottle pin */}
        <g transform="translate(228 -8)">
          <g className="animate-bounce-pin">
            <path d="M0 34 C -12 16, -12 0, 0 0 C 12 0, 12 16, 0 34 Z" fill="#2E7D1A" />
            <rect x="-6" y="6" width="12" height="12" rx="2.5" fill="#fff" />
            <rect x="-3.4" y="3.4" width="6.8" height="3" rx="1" fill="#fff" />
          </g>
        </g>
      </g>
      {/* small city block cluster right */}
      <g transform="translate(360 58)" fill="#CFE3D2">
        <rect x="0" y="20" width="30" height="52" rx="4" />
        <rect x="36" y="4" width="26" height="68" rx="4" fill="#B9D4BC" />
        <rect x="68" y="30" width="30" height="42" rx="4" />
        <rect x="104" y="14" width="24" height="58" rx="4" fill="#B9D4BC" />
        <g fill="#fff" opacity="0.7">
          <rect x="6" y="28" width="6" height="6" /><rect x="18" y="28" width="6" height="6" />
          <rect x="42" y="14" width="6" height="6" /><rect x="52" y="14" width="6" height="6" />
          <rect x="74" y="40" width="6" height="6" /><rect x="86" y="40" width="6" height="6" />
          <rect x="110" y="24" width="6" height="6" /><rect x="118" y="24" width="6" height="6" />
        </g>
      </g>
    </svg>
  )
}

/* ── Staff scene (clipboard + shield) ───────────────────────────── */
export function StaffScene({ className }: { className?: string }) {
  const ticks = [0, 1, 2, 3]
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      {/* clipboard */}
      <g transform="translate(96 22) rotate(-6)">
        <rect x="0" y="0" width="120" height="128" rx="10" fill="#E7DFD3" />
        <rect x="8" y="10" width="104" height="112" rx="7" fill="#FDFBF4" />
        <rect x="38" y="-7" width="44" height="16" rx="6" fill="#8B5E3C" />
        {ticks.map((i) => (
          <g key={i} transform={`translate(20 ${26 + i * 22})`}>
            <motion.g
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.4 + i * 0.28, type: 'spring', stiffness: 300, damping: 16 }}
              style={{ transformOrigin: '6px 6px' }}
            >
              <rect x="0" y="0" width="9" height="9" rx="2.5" fill="#7FCB62" />
              <path d="M2.4 4.6 l1.8 2 3 -3.6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              <rect x="16" y="2" width={64 - (i % 2) * 14} height="5" rx="2.5" fill="#D8D2C4" />
            </motion.g>
          </g>
        ))}
      </g>
      {/* shield */}
      <g transform="translate(300 30)">
        <g className="animate-floaty" style={{ animationDuration: '6s' }}>
          <circle className="animate-pulse-soft" cx="52" cy="52" r="64" fill="#2E7D1A" opacity="0.08" />
          <path d="M52 6 L92 22 V52 C92 78 74 92 52 100 C30 92 12 78 12 52 V22 Z" fill="url(#shieldGrad)" />
          <path d="M52 6 L92 22 V52 C92 78 74 92 52 100 C30 92 12 78 12 52 V22 Z" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="2" />
          <rect x="42" y="40" width="20" height="16" rx="3" fill="#F5F2EA" />
          <path d="M45 40 v-5 a7 7 0 0 1 14 0 v5" stroke="#F5F2EA" strokeWidth="3.4" fill="none" />
          <circle cx="52" cy="48" r="3" fill="#2E7D1A" />
        </g>
        {/* leaves */}
        <g className="animate-sway" style={{ transformOrigin: '112px 96px' }}>
          <ellipse cx="112" cy="92" rx="10" ry="5" fill="#7FCB62" transform="rotate(-24 112 92)" />
          <ellipse cx="124" cy="82" rx="8" ry="4" fill="#5DAE2B" transform="rotate(-14 124 82)" />
        </g>
      </g>
      <defs>
        <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4C9E2F" />
          <stop offset="100%" stopColor="#2E7D1A" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/* ── Offers scene (tag + bottle + cheese + sparkles) ────────────── */
export function OffersScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g fill="#7FCB62" opacity="0.5" className="animate-sway" style={{ transformOrigin: '40px 120px' }}>
        <ellipse cx="40" cy="118" rx="26" ry="14" />
        <ellipse cx="16" cy="132" rx="18" ry="10" />
      </g>
      {/* milk glass */}
      <g transform="translate(84 76)">
        <path d="M0 0 h30 l-4 56 h-22 z" fill="#FDFBF4" stroke="#D8D2C4" strokeWidth="1.6" />
        <path d="M2.4 10 h25.2 l-3.4 44 h-18.4 z" fill="#F6F1E2" />
      </g>
      {/* bottle */}
      <g transform="translate(140 22)">
        <g className="animate-floaty" style={{ animationDuration: '5.4s' }}>
          <ellipse cx="26" cy="122" rx="30" ry="5" fill="#3F6212" opacity="0.12" />
          <path d="M14 34 h24 v10 c8 8 10 18 10 30 v34 a10 10 0 0 1 -10 10 h-24 a10 10 0 0 1 -10 -10 v-34 c0 -12 2 -22 10 -30 z" fill="#FDFBF4" stroke="#D8D2C4" strokeWidth="1.4" />
          <rect x="16" y="24" width="20" height="12" rx="3" fill="#E7DFD3" />
          <rect x="10" y="74" width="32" height="26" rx="4" fill="#fff" stroke="#E3DCCB" />
          <g transform="translate(16 79) scale(0.5)"><CowMark size={36} /></g>
        </g>
      </g>
      {/* cheese + paneer */}
      <g transform="translate(236 92)">
        <g className="animate-floaty" style={{ animationDuration: '4.6s', animationDelay: '0.6s' }}>
          <path d="M0 34 L34 10 C42 16 44 26 44 34 Z" fill="#F5C242" transform="translate(0 8)" />
          <rect x="50" y="18" width="26" height="24" rx="4" fill="#FDFCF7" stroke="#E3DCCB" />
          <rect x="80" y="26" width="20" height="16" rx="4" fill="#F6EFDD" />
        </g>
      </g>
      {/* discount tag */}
      <g transform="translate(330 34) rotate(-10)">
        <g className="animate-wiggle">
          <rect x="0" y="0" width="132" height="84" rx="14" fill="url(#tagGrad)" />
          <rect x="0" y="0" width="132" height="84" rx="14" fill="none" stroke="#fff" strokeOpacity="0.3" strokeWidth="2" strokeDasharray="6 5" />
          <text x="66" y="30" textAnchor="middle" fontSize="15" fontWeight="700" fill="#DFF3D0">UP TO</text>
          <text x="66" y="62" textAnchor="middle" fontSize="30" fontWeight="800" fill="#fff">20% OFF</text>
          <circle cx="14" cy="42" r="5" fill="#F7FBF2" />
        </g>
        {/* sparkles */}
        <g fill="#7FCB62" className="animate-pulse-soft">
          <path d="M138 8 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 z" />
          <path d="M-16 66 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" opacity="0.8" />
        </g>
      </g>
      <defs>
        <linearGradient id="tagGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5DAE2B" />
          <stop offset="100%" stopColor="#2E7D1A" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/* ── Sidebar bottom scene (cow + bottle + grass) ────────────────── */
export function SidebarScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <defs>
        <pattern id="cowPatch2" width="26" height="22" patternUnits="userSpaceOnUse">
          <ellipse cx="8" cy="7" rx="5" ry="4" fill="#3D3128" opacity="0.7" />
        </pattern>
      </defs>
      {/* grass base */}
      <path d="M0 128 Q 60 116 120 126 T 240 122 V150 H0 Z" fill="#8CC25C" />
      {Array.from({ length: 14 }).map((_, i) => (
        <g key={i} className="animate-sway" style={{ transformOrigin: `${12 + i * 16}px 130px`, animationDelay: `${(i % 5) * 0.35}s` }}>
          <path d={`M${12 + i * 16} 130 q -2 -8 1 -12`} stroke="#5F9A3C" strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
      ))}
      {/* grazing cow */}
      <g transform="translate(74 104) scale(1.15)">
        <g className="animate-bob" style={{ animationDuration: '4.4s' }}>
          <rect x="-18" y="-8" width="34" height="18" rx="9" fill="#fff" />
          <rect x="-18" y="-8" width="34" height="18" rx="9" fill="url(#cowPatch2)" />
          <path d="M10 -4 q10 -4 12 4 q0 8 -10 6 z" fill="#fff" />
          <ellipse cx="18" cy="4" rx="4" ry="3" fill="#F7C8CF" />
          <path d="M-18 0 q-8 2 -9 9" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" className="animate-sway" style={{ transformOrigin: '-18px 0px' }} />
          <rect x="-14" y="9" width="5" height="10" rx="2.5" fill="#E7DFD3" />
          <rect x="8" y="9" width="5" height="10" rx="2.5" fill="#E7DFD3" />
          <rect x="-4" y="9" width="5" height="10" rx="2.5" fill="#E7DFD3" />
          <rect x="14" y="9" width="5" height="10" rx="2.5" fill="#E7DFD3" />
        </g>
      </g>
      {/* milk bottle */}
      <g transform="translate(176 66)">
        <g className="animate-floaty" style={{ animationDuration: '5s' }}>
          <path d="M8 22 h14 v6 c5 5 6 11 6 18 v22 a7 7 0 0 1 -7 7 h-12 a7 7 0 0 1 -7 -7 v-22 c0 -7 1 -13 6 -18 z" fill="#FDFBF4" stroke="#D8D2C4" strokeWidth="1.2" />
          <rect x="9" y="16" width="12" height="8" rx="2" fill="#E7DFD3" />
          <rect x="5" y="46" width="20" height="15" rx="3" fill="#fff" stroke="#E3DCCB" />
          <g transform="translate(8 49) scale(0.4)"><CowMark size={30} /></g>
          {/* droplets */}
          <circle className="animate-bounce-pin" cx="30" cy="18" r="2.4" fill="#9FC4DD" style={{ animationDuration: '2.8s' }} />
          <circle className="animate-bounce-pin" cx="-8" cy="30" r="2" fill="#9FC4DD" style={{ animationDuration: '3.4s', animationDelay: '0.7s' }} />
        </g>
      </g>
    </svg>
  )
}

/* ── Finance scene (milk can + coins + chart bars) ──────────────── */
export function FinanceScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g transform="translate(150 44)">
        <ellipse cx="30" cy="106" rx="36" ry="5" fill="#3F6212" opacity="0.12" />
        <path d="M6 24 h48 v10 c6 4 8 10 8 16 v44 a10 10 0 0 1 -10 10 h-44 a10 10 0 0 1 -10 -10 v-44 c0 -6 2 -12 8 -16 z" fill="#DCE4E8" />
        <rect x="10" y="14" width="40" height="12" rx="3" fill="#9AA7B0" />
        <ellipse cx="30" cy="12" rx="18" ry="5" fill="#B9C4CC" />
        <rect x="8" y="52" width="44" height="26" rx="4" fill="#fff" />
        <g transform="translate(14 57) scale(0.55)"><CowMark size={30} /></g>
      </g>
      {/* coins */}
      <g transform="translate(268 96)">
        <g className="animate-floaty" style={{ animationDuration: '4.8s' }}>
          <ellipse cx="0" cy="18" rx="20" ry="6" fill="#F5A623" />
          <ellipse cx="0" cy="12" rx="20" ry="6" fill="#F5C242" />
          <ellipse cx="0" cy="6" rx="20" ry="6" fill="#F5A623" />
          <ellipse cx="0" cy="0" rx="20" ry="6" fill="#FFD978" />
        </g>
        <g className="animate-floaty" style={{ animationDuration: '5.6s', animationDelay: '0.5s' }} transform="translate(56 -10)">
          <ellipse cx="0" cy="28" rx="16" ry="5" fill="#F5A623" />
          <ellipse cx="0" cy="22" rx="16" ry="5" fill="#F5C242" />
          <ellipse cx="0" cy="16" rx="16" ry="5" fill="#FFD978" />
        </g>
      </g>
      {/* rising bars */}
      <g transform="translate(360 60)">
        {[24, 40, 58, 78].map((h, i) => (
          <rect key={i} x={i * 24} y={96 - h} width="14" height={h} rx="4" fill={i === 3 ? '#2E7D1A' : '#A8DC8B'} className="animate-pulse-soft" style={{ animationDelay: `${i * 0.4}s`, animationDuration: '3.4s' }} />
        ))}
        <path d="M4 72 q22 -18 44 -30 t50 -26" stroke="#2E7D1A" strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="5 7" className="animate-drift" style={{ animationDuration: '7s' }} />
      </g>
    </svg>
  )
}

/* ── Empty / 404 / login illustrations ──────────────────────────── */
export function EmptyIllustration({ kind = 'box', className }: { kind?: 'box' | 'search' | 'bell' | 'cow404'; className?: string }) {
  return (
    <svg viewBox="0 0 220 150" className={className} aria-hidden>
      <circle cx="110" cy="78" r="62" fill="#F0F7EA" />
      {kind === 'box' && (
        <g transform="translate(74 44)">
          <g className="animate-floaty">
            <path d="M0 18 L36 0 L72 18 L36 36 Z" fill="#5DAE2B" />
            <path d="M0 18 V58 L36 76 V36 Z" fill="#2E7D1A" />
            <path d="M72 18 V58 L36 76 V36 Z" fill="#43961E" />
            <rect x="26" y="14" width="20" height="10" rx="2" fill="#DFF3D0" />
          </g>
        </g>
      )}
      {kind === 'search' && (
        <g transform="translate(76 48)">
          <circle cx="26" cy="26" r="24" fill="none" stroke="#5DAE2B" strokeWidth="6" className="animate-floaty" />
          <path d="M44 44 l18 18" stroke="#2E7D1A" strokeWidth="7" strokeLinecap="round" className="animate-floaty" />
        </g>
      )}
      {kind === 'bell' && (
        <g transform="translate(78 42)" className="animate-sway" style={{ transformOrigin: '32px 20px' }}>
          <path d="M32 0 c-14 0 -22 10 -22 26 v16 l-8 10 h60 l-8 -10 v-16 c0 -16 -8 -26 -22 -26z" fill="#5DAE2B" />
          <circle cx="32" cy="58" r="7" fill="#2E7D1A" />
        </g>
      )}
      {kind === 'cow404' && (
        <g transform="translate(64 40)">
          <g className="animate-bob">
            <circle cx="46" cy="36" r="34" fill="#fff" stroke="#D8D2C4" strokeWidth="2" />
            <ellipse cx="46" cy="46" rx="16" ry="10" fill="#F7C8CF" />
            <circle cx="39" cy="44" r="3" fill="#B05560" />
            <circle cx="53" cy="44" r="3" fill="#B05560" />
            <ellipse cx="26" cy="24" rx="9" ry="6" fill="#fff" stroke="#D8D2C4" transform="rotate(-24 26 24)" />
            <ellipse cx="66" cy="24" rx="9" ry="6" fill="#fff" stroke="#D8D2C4" transform="rotate(24 66 24)" />
            <circle cx="32" cy="28" r="4" fill="#2B2118" />
            <circle cx="60" cy="28" r="4" fill="#2B2118" />
            <text x="46" y="14" textAnchor="middle" fontSize="16" fontWeight="800" fill="#2E7D1A">?</text>
          </g>
        </g>
      )}
    </svg>
  )
}

export function LoginHero({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 420 300" className={className} aria-hidden preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="loginSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#EAF6F0" />
          <stop offset="100%" stopColor="#F7FBF2" />
        </linearGradient>
      </defs>
      <rect width="420" height="300" rx="24" fill="url(#loginSky)" />
      <circle className="animate-pulse-soft" cx="340" cy="60" r="36" fill="#FFD978" opacity="0.9" />
      <Cloud x={90} y={50} scale={0.9} dur={30} />
      <path d="M0 210 Q 100 170 220 204 T 420 196 V300 H0 Z" fill="#A8DC8B" />
      <g transform="translate(60 120)">
        <rect x="60" y="30" width="90" height="60" rx="6" fill="#C23B3B" />
        <path d="M54 30 L105 0 L156 30 Z" fill="#9E2F2F" />
        <rect x="90" y="56" width="30" height="34" rx="3" fill="#7A4A21" />
        <g transform="translate(70 38)">
          <rect width="18" height="10" rx="1.5" fill="#2B6CB0" opacity="0.9" />
          <rect x="22" width="18" height="10" rx="1.5" fill="#2B6CB0" opacity="0.75" />
        </g>
      </g>
      <Tree x={210} y={196} scale={1} />
      <Tree x={350} y={190} scale={0.8} />
      <Cow x={120} y={236} scale={1} />
      <Cow x={240} y={244} scale={0.8} flip dur={4.2} />
      <g transform="translate(300 170)">
        <g className="animate-floaty">
          <path d="M8 22 h14 v6 c5 5 6 11 6 18 v22 a7 7 0 0 1 -7 7 h-12 a7 7 0 0 1 -7 -7 v-22 c0 -7 1 -13 6 -18 z" fill="#FDFBF4" stroke="#D8D2C4" strokeWidth="1.2" />
          <rect x="5" y="46" width="20" height="15" rx="3" fill="#fff" stroke="#E3DCCB" />
        </g>
      </g>
    </svg>
  )
}

/* ── New section headers for the refactored spec pages ──────────── */

function Sparkle({ x, y, color = '#7FCB62', dur = 2.4, delay = 0 }: { x: number; y: number; color?: string; dur?: number; delay?: number }) {
  return (
    <g transform={`translate(${x} ${y})`} className="animate-pulse-soft" style={{ animationDuration: `${dur}s`, animationDelay: `${delay}s` }}>
      <path d="M0 -7 L2 -2 7 0 2 2 0 7 -2 2 -7 0 -2 -2 Z" fill={color} />
    </g>
  )
}

export function ProductsScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      {/* shelf */}
      <rect x="60" y="118" width="240" height="6" rx="3" fill="#E7DFD3" />
      <rect x="60" y="72" width="240" height="6" rx="3" fill="#E7DFD3" />
      {/* bottles on shelf */}
      <g transform="translate(76 40)">
        <g className="animate-floaty" style={{ animationDuration: '4.8s' }}>
          <path d="M8 18 h14 v6 c5 5 6 11 6 18 v20 a7 7 0 0 1 -7 7 h-12 a7 7 0 0 1 -7 -7 v-20 c0 -7 1 -13 6 -18 z" fill="#FDFBF4" stroke="#D8D2C4" />
          <rect x="9" y="12" width="12" height="8" rx="2" fill="#2E7D1A" />
        </g>
      </g>
      <g transform="translate(120 42)">
        <g className="animate-floaty" style={{ animationDuration: '5.6s', animationDelay: '.5s' }}>
          <path d="M10 18 h16 v6 c6 5 7 12 7 19 v18 a8 8 0 0 1 -8 8 h-14 a8 8 0 0 1 -8 -8 v-18 c0 -7 1 -14 7 -19 z" fill="#FDFBF4" stroke="#D8D2C4" />
          <rect x="11" y="12" width="14" height="8" rx="2" fill="#F5A623" />
        </g>
      </g>
      <g transform="translate(170 46)">
        <g className="animate-floaty" style={{ animationDuration: '4.4s', animationDelay: '1s' }}>
          <rect x="0" y="10" width="30" height="38" rx="4" fill="#FDFCF7" stroke="#E3DCCB" />
          <rect x="4" y="16" width="22" height="14" rx="3" fill="#EAF3E2" />
          <rect x="4" y="34" width="22" height="4" rx="2" fill="#D8D2C4" />
          <rect x="10" y="2" width="10" height="10" rx="2" fill="#7A4A21" />
        </g>
      </g>
      <g transform="translate(228 50)">
        <g className="animate-floaty" style={{ animationDuration: '5s', animationDelay: '1.4s' }}>
          <path d="M0 30 L26 8 C33 13 35 22 35 30 Z" fill="#F5C242" />
          <rect x="40" y="14" width="20" height="16" rx="3" fill="#FDFCF7" stroke="#E3DCCB" />
        </g>
      </g>
      {/* price tag */}
      <g transform="translate(336 28) rotate(-8)">
        <g className="animate-wiggle">
          <rect x="0" y="0" width="120" height="72" rx="12" fill="url(#prodTag)" />
          <circle cx="12" cy="36" r="4.5" fill="#F7FBF2" />
          <text x="64" y="30" textAnchor="middle" fontSize="12" fontWeight="700" fill="#DFF3D0">PRICING</text>
          <text x="64" y="54" textAnchor="middle" fontSize="20" fontWeight="800" fill="#fff">₹ ₹ ₹</text>
        </g>
        <Sparkle x={128} y={6} />
        <Sparkle x={-10} y={60} color="#F5A623" dur={3} delay={0.6} />
      </g>
      <defs>
        <linearGradient id="prodTag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5DAE2B" />
          <stop offset="100%" stopColor="#2E7D1A" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function InventoryScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      {/* stacked boxes */}
      <g transform="translate(120 60)">
        <g className="animate-floaty" style={{ animationDuration: '4.6s' }}>
          <rect x="0" y="40" width="52" height="40" rx="5" fill="#E7DFD3" />
          <rect x="6" y="46" width="40" height="10" rx="2" fill="#D8D2C4" />
          <rect x="8" y="16" width="44" height="34" rx="5" fill="#CBEBB4" />
          <rect x="14" y="22" width="32" height="8" rx="2" fill="#A8DC8B" />
          <rect x="12" y="-8" width="36" height="30" rx="5" fill="#7FCB62" />
          <rect x="18" y="-2" width="24" height="7" rx="2" fill="#fff" opacity="0.75" />
        </g>
      </g>
      {/* trolley */}
      <g transform="translate(240 84)">
        <g className="animate-bob" style={{ animationDuration: '3.6s' }}>
          <path d="M0 0 h60 l-8 28 h-44 z" fill="#D8D2C4" />
          <path d="M8 6 h44 l-6 16 h-32 z" fill="#FDFBF4" />
          <circle cx="14" cy="40" r="7" fill="#2B2118" />
          <circle cx="44" cy="40" r="7" fill="#2B2118" />
          <path d="M60 0 l10 -12" stroke="#8B5E3C" strokeWidth="4" fill="none" strokeLinecap="round" />
        </g>
      </g>
      {/* gauge badge */}
      <g transform="translate(344 36)">
        <g className="animate-floaty" style={{ animationDuration: '5.8s' }}>
          <rect x="0" y="0" width="128" height="76" rx="14" fill="#F7FBF2" stroke="#CBEBB4" />
          <rect x="14" y="14" width="14" height="48" rx="3" fill="#A8DC8B" />
          <rect x="34" y="26" width="14" height="36" rx="3" fill="#7FCB62" />
          <rect x="54" y="10" width="14" height="52" rx="3" fill="#5DAE2B" />
          <rect x="74" y="34" width="14" height="28" rx="3" fill="#CBEBB4" />
          <circle cx="108" cy="24" r="10" fill="none" stroke="#2E7D1A" strokeWidth="4" strokeDasharray="47 63" strokeLinecap="round" transform="rotate(-90 108 24)" />
          <Sparkle x={112} y={56} />
        </g>
      </g>
    </svg>
  )
}

export function PaymentsScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g transform="translate(150 40)">
        <ellipse cx="36" cy="106" rx="40" ry="5" fill="#3F6212" opacity="0.12" />
        <rect x="0" y="20" width="72" height="76" rx="10" fill="#5DAE2B" />
        <rect x="0" y="20" width="72" height="20" rx="8" fill="#4C9E2F" />
        <rect x="10" y="48" width="52" height="10" rx="4" fill="#DFF3D0" />
        <circle cx="58" cy="80" r="10" fill="#FFD978" />
        <path d="M55 80 h6 M58 77 v6" stroke="#7A4A21" strokeWidth="2" strokeLinecap="round" />
      </g>
      <g transform="translate(268 74)">
        <g className="animate-floaty" style={{ animationDuration: '4.8s' }}>
          <ellipse cx="0" cy="20" rx="22" ry="7" fill="#F5A623" />
          <ellipse cx="0" cy="13" rx="22" ry="7" fill="#F5C242" />
          <ellipse cx="0" cy="6" rx="22" ry="7" fill="#FFD978" />
        </g>
        <g className="animate-floaty" style={{ animationDuration: '5.4s', animationDelay: '.6s' }} transform="translate(58 -6)">
          <ellipse cx="0" cy="26" rx="18" ry="6" fill="#F5A623" />
          <ellipse cx="0" cy="20" rx="18" ry="6" fill="#FFD978" />
        </g>
      </g>
      <g transform="translate(356 44)">
        <g className="animate-floaty" style={{ animationDuration: '5s', animationDelay: '.9s' }}>
          <rect x="0" y="0" width="126" height="72" rx="14" fill="#F7FBF2" stroke="#CBEBB4" />
          <path d="M18 24 h90" stroke="#A8DC8B" strokeWidth="3" strokeLinecap="round" />
          <path d="M18 38 h70" stroke="#CBEBB4" strokeWidth="3" strokeLinecap="round" />
          <path d="M18 52 h82" stroke="#CBEBB4" strokeWidth="3" strokeLinecap="round" />
          <text x="24" y="18" fontSize="11" fontWeight="700" fill="#2E7D1A">Refunds</text>
          <circle cx="106" cy="18" r="6" fill="#E5484D" opacity="0.85" />
        </g>
      </g>
    </svg>
  )
}

export function PayoutsScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g transform="translate(140 96)">
        <g className="animate-bob">
          <ellipse cx="0" cy="40" rx="46" ry="5" fill="#3F6212" opacity="0.14" />
          <g className="animate-spin-slow" style={{ animationDuration: '1s', transformOrigin: '-20px 26px' }}>
            <circle cx="-20" cy="26" r="11" fill="#2B2118" /><circle cx="-20" cy="26" r="5" fill="#9C948A" />
          </g>
          <g className="animate-spin-slow" style={{ animationDuration: '1s', transformOrigin: '30px 26px' }}>
            <circle cx="30" cy="26" r="11" fill="#2B2118" /><circle cx="30" cy="26" r="5" fill="#9C948A" />
          </g>
          <path d="M-20 26 h14 l10 -16 h10 l6 16 h10" stroke="#2E7D1A" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="8" y="-4" width="24" height="16" rx="3" fill="#5DAE2B" />
          <circle cx="4" cy="-16" r="8" fill="#E8B48B" />
          <path d="M-3 -18 a8 8 0 0 1 15 -1 l-3 -1.6 q-5 -3 -9 1 z" fill="#2E7D1A" />
        </g>
      </g>
      <g transform="translate(300 40)">
        <g className="animate-floaty" style={{ animationDuration: '5.2s' }}>
          <rect x="0" y="0" width="130" height="80" rx="14" fill="url(#payoutGrad)" />
          <text x="65" y="28" textAnchor="middle" fontSize="12" fontWeight="700" fill="#DFF3D0">PAYOUT</text>
          <text x="65" y="52" textAnchor="middle" fontSize="19" fontWeight="800" fill="#fff">₹ 12,480</text>
          <rect x="18" y="62" width="94" height="8" rx="4" fill="#fff" opacity="0.3" />
          <rect x="18" y="62" width="64" height="8" rx="4" fill="#fff" opacity="0.85" />
        </g>
        <Sparkle x={140} y={8} />
        <Sparkle x={-12} y={62} color="#FFD978" dur={3} delay={0.5} />
      </g>
      <defs>
        <linearGradient id="payoutGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5DAE2B" />
          <stop offset="100%" stopColor="#2E7D1A" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function SupportScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g transform="translate(140 30)">
        <g className="animate-floaty" style={{ animationDuration: '4.6s' }}>
          <circle cx="40" cy="60" r="34" fill="#5DAE2B" />
          <path d="M18 52 a22 22 0 0 1 44 0 v10 a6 6 0 0 1 -6 6 h-6 v-14 h10" stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round" />
          <path d="M62 52 a22 22 0 0 0 -44 0" stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round" />
          <rect x="10" y="52" width="10" height="16" rx="4" fill="#fff" />
          <rect x="60" y="52" width="10" height="16" rx="4" fill="#fff" />
          <circle cx="40" cy="104" r="7" fill="#2E7D1A" />
        </g>
      </g>
      <g transform="translate(240 34)">
        <g className="animate-floaty" style={{ animationDuration: '5.4s', animationDelay: '.6s' }}>
          <rect x="0" y="0" width="120" height="78" rx="12" fill="#F7FBF2" stroke="#CBEBB4" />
          <path d="M14 22 h70" stroke="#A8DC8B" strokeWidth="3" strokeLinecap="round" />
          <path d="M14 36 h92" stroke="#CBEBB4" strokeWidth="3" strokeLinecap="round" />
          <path d="M14 50 h60" stroke="#CBEBB4" strokeWidth="3" strokeLinecap="round" />
          <text x="14" y="70" fontSize="10" fontWeight="700" fill="#2E7D1A">★ ★ ★ ★ ☆</text>
        </g>
        <Sparkle x={128} y={4} dur={3} />
      </g>
    </svg>
  )
}

export function ApprovalsScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      <g transform="translate(150 34)">
        <g className="animate-floaty" style={{ animationDuration: '5s' }}>
          <rect x="0" y="0" width="120" height="92" rx="10" fill="#E7DFD3" />
          <rect x="8" y="10" width="104" height="74" rx="7" fill="#FDFBF4" />
          <rect x="18" y="22" width="60" height="6" rx="3" fill="#D8D2C4" />
          <rect x="18" y="36" width="80" height="6" rx="3" fill="#D8D2C4" />
          <rect x="18" y="50" width="52" height="6" rx="3" fill="#D8D2C4" />
          <motion.g initial={{ scale: 0, rotate: -30, opacity: 0 }} animate={{ scale: 1, rotate: -12, opacity: 1 }} transition={{ delay: 0.5, type: 'spring', stiffness: 260, damping: 14 }} style={{ transformOrigin: '84px 66px' }}>
            <circle cx="84" cy="66" r="20" fill="#2E7D1A" />
            <path d="M75 66 l6 6 12 -13" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </motion.g>
        </g>
      </g>
      <g transform="translate(320 36)">
        <g className="animate-floaty" style={{ animationDuration: '5.8s', animationDelay: '.7s' }}>
          <path d="M52 4 L96 20 V52 C96 78 76 94 52 102 C28 94 8 78 8 52 V20 Z" fill="url(#apprShield)" />
          <path d="M52 4 L96 20 V52 C96 78 76 94 52 102 C28 94 8 78 8 52 V20 Z" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="2" />
          <rect x="42" y="34" width="20" height="16" rx="3" fill="#F5F2EA" />
          <path d="M45 34 v-5 a7 7 0 0 1 14 0 v5" stroke="#F5F2EA" strokeWidth="3.4" fill="none" />
          <circle cx="52" cy="42" r="3" fill="#2E7D1A" />
        </g>
        <Sparkle x={106} y={10} dur={2.8} />
      </g>
      <defs>
        <linearGradient id="apprShield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4C9E2F" />
          <stop offset="100%" stopColor="#2E7D1A" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function PeopleScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 160" className={className} aria-hidden preserveAspectRatio="xMidYMax meet">
      <rect width="520" height="160" fill="none" />
      {[
        { x: 150, y: 90, s: 1, d: '0s' },
        { x: 215, y: 70, s: 0.85, d: '.4s' },
        { x: 275, y: 96, s: 0.95, d: '.8s' },
        { x: 335, y: 76, s: 0.8, d: '1.2s' },
      ].map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.y}) scale(${p.s})`} className="animate-floaty" style={{ animationDuration: '4.6s', animationDelay: p.d }}>
          <circle cx="0" cy="-24" r="20" fill={i % 2 ? '#E8B48B' : '#F2C7A4'} />
          <path d="M-20 -28 a20 20 0 0 1 40 0 q-10 -10 -40 0z" fill={i % 2 ? '#2B2118' : '#6B4423'} />
          <path d="M-26 26 C -24 4, 24 4, 26 26 Z" fill={['#2E7D1A', '#3B9DF0', '#F5A623', '#8B5CF6'][i]} />
          <circle cx="-7" cy="-24" r="2.2" fill="#2B2118" />
          <circle cx="7" cy="-24" r="2.2" fill="#2B2118" />
          <path d="M-5 -17 q5 4 10 0" stroke="#2B2118" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
      ))}
    </svg>
  )
}
