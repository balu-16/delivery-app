import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ── Select ─────────────────────────────────────────────────── */
export interface SelectOption { value: string; label: string }

export function Select({
  value, onValueChange, options, placeholder = 'Select…', className, disabled,
}: {
  value: string
  onValueChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-input bg-card px-3.5 text-sm shadow-innersoft transition-colors focus:outline-none focus:ring-2 focus:ring-ring/60 disabled:opacity-50 data-[placeholder]:text-muted-foreground/70',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon><ChevronDown className="h-4 w-4 text-muted-foreground" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-72 overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-lift data-[state=open]:animate-in"
        >
          <SelectPrimitive.Viewport className="scrollbar-thin">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={(o as { disabled?: boolean }).disabled}
                className="flex cursor-pointer select-none items-center justify-between rounded-lg px-3 py-2 text-[13px] font-medium outline-none data-[highlighted]:bg-primary-soft data-[state=checked]:font-semibold data-[state=checked]:text-brand-700 data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed dark:data-[state=checked]:text-brand-300"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator><Check className="h-3.5 w-3.5" /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/** Compact select for toolbars. */
export function ToolbarSelect({
  value, onValueChange, options, icon, className,
}: {
  value: string
  onValueChange: (v: string) => void
  options: SelectOption[]
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      options={options}
      className={cn('h-10 rounded-xl', className)}
    />
  )
}

/* ── Form field wrapper ─────────────────────────────────────── */
export function Field({
  label, error, required, children, hint, className,
}: {
  label?: string
  error?: string
  required?: boolean
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="mb-1.5 text-[13px] font-semibold text-foreground/90">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </div>
      )}
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="mt-1 text-xs font-medium text-destructive">{error}</p>}
    </div>
  )
}
