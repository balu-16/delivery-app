import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './base'

/* ── Dialog ─────────────────────────────────────────────────── */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  className, children, title, description, wide,
}: {
  className?: string
  children: React.ReactNode
  title: string
  description?: string
  wide?: boolean
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px] data-[state=open]:animate-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-card p-6 shadow-lift focus:outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          wide ? 'max-w-2xl' : 'max-w-md',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="text-lg font-bold tracking-tight">{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/* ── Side drawer (right panel) ──────────────────────────────── */
export function Drawer({
  open, onOpenChange, title, subtitle, children, footer, width = 'md',
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: 'sm' | 'md' | 'lg'
}) {
  const w = width === 'sm' ? 'max-w-sm' : width === 'lg' ? 'max-w-xl' : 'max-w-md'
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-[1.5px]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-2 right-2 z-50 flex w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-card border border-border bg-card shadow-lift focus:outline-none',
            w,
          )}
          style={{ animation: 'drawerIn .34s cubic-bezier(.22,1,.36,1)' }}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border/70 px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-base font-bold tracking-tight">{title}</DialogPrimitive.Title>
              {subtitle && <DialogPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">{subtitle}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="border-t border-border/70 px-5 py-3.5">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ── Confirm dialog ─────────────────────────────────────────── */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = 'Confirm', destructive, onConfirm, processing,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  processing?: boolean
}) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px]" />
        <AlertDialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-card p-6 shadow-lift focus:outline-none">
          <AlertDialogPrimitive.Title className="text-lg font-bold tracking-tight">{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="mt-1.5 text-sm text-muted-foreground">{description}</AlertDialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="secondary" size="md">Cancel</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant={destructive ? 'destructive' : 'primary'} size="md" onClick={onConfirm} disabled={processing}>
                {processing ? 'Working…' : confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}

/* ── Dropdown menu ──────────────────────────────────────────── */
export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger

export function DropdownMenuContent({ className, children, align = 'end' }: { className?: string; children: React.ReactNode; align?: 'start' | 'center' | 'end' }) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={6}
        className={cn(
          'z-50 min-w-[10rem] overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-lift',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
      >
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  )
}
export function DropdownItem({ className, danger, ...props }: React.ComponentProps<typeof DropdownPrimitive.Item> & { danger?: boolean }) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium outline-none transition-colors data-[highlighted]:bg-primary-soft',
        danger && 'text-destructive data-[highlighted]:bg-destructive-soft',
        className,
      )}
      {...props}
    />
  )
}
export function DropdownLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <DropdownPrimitive.Label className={cn('px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground', className)}>{children}</DropdownPrimitive.Label>
}
export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" />
}

/* ── Popover ────────────────────────────────────────────────── */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export function PopoverContent({ className, children, align = 'end' }: { className?: string; children: React.ReactNode; align?: 'start' | 'center' | 'end' }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={8}
        className={cn('z-50 w-72 rounded-xl border border-border bg-card p-4 shadow-lift focus:outline-none', className)}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/* ── Tooltip ────────────────────────────────────────────────── */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>
}
export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-lg bg-foreground px-2.5 py-1.5 text-[11px] font-medium text-background shadow-lift"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-foreground" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
