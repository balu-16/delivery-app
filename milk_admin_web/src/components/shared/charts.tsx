import React from 'react'
import {
  Area, AreaChart, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { StatusSlice } from '@/types'
import { cn } from '@/lib/utils'
import { fmtCompactINR, fmtNum } from '@/lib/utils'

/* ── Tooltip ────────────────────────────────────────────────── */
export function ChartTooltip({ active, payload, label, fmtValue }: any & { fmtValue?: (v: number, key?: string) => string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      {label !== undefined && <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</div>}
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.fill }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto font-bold tabular">{fmtValue ? fmtValue(p.value, p.dataKey) : fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Sparkline (KPI cards) ──────────────────────────────────── */
export const Sparkline = React.memo(function Sparkline({ data, color = '#2E7D1A', height = 44, dataKey = 'v' }: { data: Array<any>; color?: string; height?: number; dataKey?: string }) {
  const id = React.useId()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2}
          fill={`url(#${id})`} isAnimationActive animationDuration={600}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
})

/* ── Trend chart (area + line, animated draw) ───────────────── */
export const TrendChart = React.memo(function TrendChart({
  data, xKey = 'label', yKey = 'orders', color = '#2E7D1A', height = 240, yFmt = fmtNum, area = true, name = 'Orders',
}: {
  data: Array<any>
  xKey?: string
  yKey?: string
  color?: string
  height?: number
  yFmt?: (v: number) => string
  area?: boolean
  name?: string
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      {area ? (
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="4 8" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} dy={6} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(v) => yFmt(v as number)} width={54} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: color, strokeOpacity: 0.2 }} />
          <Area
            type="monotone" dataKey={yKey} name={name} stroke={color} strokeWidth={2.4}
            fill="url(#trendFill)" animationDuration={650}
            activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} dot={{ r: 3, strokeWidth: 2, stroke: '#fff', fill: color }}
          />
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="4 8" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} dy={6} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(v) => yFmt(v as number)} width={54} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: color, strokeOpacity: 0.2 }} />
          <Line
            type="monotone" dataKey={yKey} name={name} stroke={color} strokeWidth={2.4}
            animationDuration={650} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }}
            dot={{ r: 3, strokeWidth: 2, stroke: '#fff', fill: color }}
          />
        </LineChart>
      )}
    </ResponsiveContainer>
  )
})

/* ── Donut with legend ──────────────────────────────────────── */
export const DonutChart = React.memo(function DonutChart({
  segments, centerLabel, centerSub, height = 210, legend = 'right', size = 160, fmtValue = fmtNum,
}: {
  segments: StatusSlice[]
  centerLabel?: string
  centerSub?: string
  height?: number
  legend?: 'right' | 'bottom' | 'none'
  size?: number
  fmtValue?: (v: number) => string
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1
  return (
    <div className={cn('flex flex-wrap items-center gap-5', legend === 'right' ? 'flex-row' : 'flex-col justify-center')}>
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={segments} dataKey="value" nameKey="label"
              innerRadius={size * 0.31} outerRadius={size * 0.47}
              paddingAngle={2} cornerRadius={6} startAngle={90} endAngle={-270}
              animationDuration={650} stroke="none"
            >
              {segments.map((s) => <Cell key={s.key} fill={s.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {centerLabel && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="text-[17px] font-extrabold tracking-tight tabular">{centerLabel}</div>
              {centerSub && <div className="text-[10px] font-medium text-muted-foreground">{centerSub}</div>}
            </div>
          </div>
        )}
      </div>
      {legend !== 'none' && (
        <ul className="min-w-[140px] flex-1 space-y-2">
          {segments.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-[12.5px]">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto font-bold tabular">{fmtValue(s.value)}</span>
              <span className="w-11 text-right text-[11px] font-semibold text-muted-foreground tabular">
                {((s.value / total) * 100).toFixed(1)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

/* ── Radial gauge (Delivery Success Rate) ───────────────────── */
export function GaugeChart({ value, label, sub, height = 190, color = '#2E7D1A' }: { value: number; label?: string; sub?: string; height?: number; color?: string }) {
  const size = 200
  const r = 78
  const cx = size / 2
  const cy = size / 2 + 16
  const arc = (from: number, to: number) => {
    const start = polar(cx, cy, r, from)
    const end = polar(cx, cy, r, to)
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${end.x} ${end.y}`
  }
  function polar(cx: number, cy: number, r: number, deg: number) {
    const rad = ((deg - 90) * Math.PI) / 180
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
  }
  const sweep = 260
  const filled = (Math.min(100, Math.max(0, value)) / 100) * sweep
  return (
    <div className="flex items-center justify-center">
      <svg width={size} height={height} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
        <path d={arc(-sweep / 2, sweep / 2)} stroke="hsl(var(--muted))" strokeWidth="14" fill="none" strokeLinecap="round" />
        <path
          d={arc(-sweep / 2, -sweep / 2 + filled)}
          stroke={color} strokeWidth="14" fill="none" strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(.22,1,.36,1)' }}
          strokeDasharray={`${filled * r * 0.01745} ${2 * Math.PI * r}`}
          transform={`rotate(${-sweep / 2 - 90} ${cx} ${cy})`}
        />
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="26" fontWeight="800" fill="hsl(var(--foreground))">{value.toFixed(1)}%</text>
        {label && <text x={cx} y={cy + 14} textAnchor="middle" fontSize="11" fontWeight="600" fill="hsl(var(--muted-foreground))">{label}</text>}
        {sub && <text x={cx} y={cy + 30} textAnchor="middle" fontSize="10" fontWeight="600" fill="#2E7D1A">{sub}</text>}
      </svg>
    </div>
  )
}

/* ── Combo chart (bars + line, dual axis) ───────────────────── */
export const ComboChart = React.memo(function ComboChart({
  data, xKey = 'label', barKey = 'revenue', lineKey = 'orders', height = 260, barName = 'Revenue', lineName = 'Orders',
}: {
  data: Array<any>
  xKey?: string
  barKey?: string
  lineKey?: string
  height?: number
  barName?: string
  lineName?: string
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5DAE2B" stopOpacity={0.9} />
            <stop offset="100%" stopColor="#5DAE2B" stopOpacity={0.25} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="4 8" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} dy={6} interval="preserveStartEnd" />
        <YAxis yAxisId="l" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(v) => fmtCompactINR(v as number)} width={52} />
        <YAxis yAxisId="r" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={36} />
        <Tooltip content={<ChartTooltip fmtValue={(v: number, key?: string) => (key === barKey ? fmtCompactINR(v) : fmtNum(v))} />} cursor={{ fill: 'hsl(var(--primary) / 0.06)' }} />
        <Bar yAxisId="l" dataKey={barKey} name={barName} fill="url(#barFill)" radius={[5, 5, 0, 0]} animationDuration={600} maxBarSize={22} />
        <Line yAxisId="r" type="monotone" dataKey={lineKey} name={lineName} stroke="#2E7D1A" strokeWidth={2.4} dot={false} animationDuration={650} />
        <Legend
          verticalAlign="top" align="right" iconType="circle" iconSize={8}
          formatter={(v) => <span className="text-[11px] font-medium text-muted-foreground">{v}</span>}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
})
