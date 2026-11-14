import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ── Button ─────────────────────────────────────────────────── */
const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      variant: {
        primary: 'gradient-primary text-white shadow-pill btn-shine hover:brightness-[1.06]',
        secondary: 'border bg-card text-foreground shadow-soft hover:bg-muted/70 hover:border-brand-200 dark:hover:bg-muted',
        outline: 'border border-brand-600/60 bg-transparent text-brand-700 dark:text-brand-300 hover:bg-primary-soft',
        ghost: 'text-muted-foreground hover:bg-primary-soft hover:text-foreground',
        destructive: 'bg-destructive text-white shadow-soft hover:brightness-105',
        success: 'bg-success text-white shadow-soft hover:brightness-105',
      },
      size: {
        sm: 'h-8 rounded-lg px-3 text-xs',
        md: 'h-10 rounded-xl px-4 text-sm',
        lg: 'h-11 rounded-full px-5 text-sm',
        pill: 'h-9 rounded-full px-4 text-sm',
        icon: 'h-9 w-9 rounded-lg',
        iconSm: 'h-7 w-7 rounded-md',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'

/* ── Card ───────────────────────────────────────────────────── */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { hoverable?: boolean }>(
  ({ className, hoverable, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-card border border-border/70 bg-card shadow-soft',
        hoverable && 'transition-all duration-300 hover:-translate-y-1 hover:shadow-lift hover:border-brand-200',
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = 'Card'
export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center justify-between gap-3 px-5 pt-5 pb-3', className)} {...props} />
)
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-[15px] font-bold tracking-tight', className)} {...props} />
)
export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 pb-5', className)} {...props} />
)

/* ── Inputs ─────────────────────────────────────────────────── */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-xl border border-input bg-card px-3.5 text-sm text-foreground shadow-innersoft transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:border-brand-300 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-[80px] w-full rounded-xl border border-input bg-card px-3.5 py-2.5 text-sm shadow-innersoft transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

export function Label({ className, children, required, ...props }: React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label className={cn('mb-1.5 block text-[13px] font-semibold text-foreground/90', className)} {...props}>
      {children}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  )
}

/* ── Badge / Kbd / Skeleton / Separator ─────────────────────── */
export function Badge({ className, tone = 'neutral', ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'green' | 'amber' | 'blue' | 'red' | 'violet' }) {
  const tones = {
    neutral: 'bg-muted text-muted-foreground',
    green: 'bg-success-soft text-success',
    amber: 'bg-warning-soft text-warning',
    blue: 'bg-info-soft text-info',
    red: 'bg-destructive-soft text-destructive',
    violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  }
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold', tones[tone], className)} {...props} />
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn('rounded-md border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-foreground', className)}>
      {children}
    </kbd>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-border', className)} />
}

/* ── Avatar ─────────────────────────────────────────────────── */
export function Avatar({ src, fallback, size = 36, className }: { src?: string; fallback: string; size?: number; className?: string }) {
  return (
    <AvatarPrimitive.Root
      className={cn('relative flex shrink-0 overflow-hidden rounded-full ring-2 ring-white dark:ring-card', className)}
      style={{ width: size, height: size }}
    >
      {src && <AvatarPrimitive.Image className="h-full w-full object-cover" src={src} />}
      <AvatarPrimitive.Fallback
        className="flex h-full w-full items-center justify-center bg-primary-soft text-[11px] font-bold text-brand-700 dark:text-brand-300"
        delayMs={src ? 300 : 0}
      >
        {fallback}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

/* ── Switch ─────────────────────────────────────────────────── */
export function Switch({ checked, onCheckedChange, className, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; className?: string; disabled?: boolean }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-40',
        checked ? 'gradient-primary' : 'bg-muted-foreground/25',
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-300 will-change-transform data-[state=checked]:translate-x-[22px]"
      />
    </SwitchPrimitive.Root>
  )
}

/* ── Checkbox ───────────────────────────────────────────────── */
export function Checkbox({ checked, onCheckedChange, className, ariaLabel }: { checked: boolean | 'indeterminate'; onCheckedChange: (v: boolean) => void; className?: string; ariaLabel?: string }) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={ariaLabel ?? 'Select'}
      className={cn(
        'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked === true || checked === 'indeterminate' ? 'gradient-primary border-transparent' : 'border-input bg-card hover:border-brand-300',
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="text-white">
        {checked === 'indeterminate' ? <span className="block h-0.5 w-2.5 rounded bg-white" /> : <Check className="h-3 w-3" strokeWidth={3} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/* ── Progress ───────────────────────────────────────────────── */
export function Progress({ value, className, barClassName }: { value: number; className?: string; barClassName?: string }) {
  return (
    <ProgressPrimitive.Root value={value} className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <ProgressPrimitive.Indicator
        className={cn('h-full rounded-full gradient-primary transition-transform duration-700 ease-out', barClassName)}
        style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value))}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}
