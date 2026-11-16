// ── §11 Support & reviews (REAL API: tickets, canned responses, ratings) ─────
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  LifeBuoy, Send, Save, Plus, ChevronLeft, ChevronRight, Paperclip, Search as SearchIcon,
  EyeOff, Eye, Undo2, Star,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useTickets, useTicket, useSavedResponses, useRatings } from '@/hooks/queries'
import { useSupportActions } from '@/hooks/mutations'
import { rupeesToPaise } from '@/api/money'
import { PageHeader, TabPills, StatusPill, EmptyState, SearchInput } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Textarea } from '@/components/ui/base'
import {
  Dialog, DialogContent, Drawer, Tooltip,
} from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import type { RatingRow, SavedResponse, TicketDetail, TicketListItem, TicketStatus } from '@/types'
import { cn, fmtDateTime } from '@/lib/utils'

type MainTab = 'tickets' | 'ratings' | 'canned'

const STATUS_OPTIONS: Array<{ value: TicketStatus; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
]

function CursorBar({ onPrev, onNext, hasPrev, hasNext, loading, label }: {
  onPrev: () => void; onNext: () => void; hasPrev: boolean; hasNext: boolean; loading: boolean; label: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!hasPrev || loading} onClick={onPrev}><ChevronLeft className="h-3.5 w-3.5" /> Prev</Button>
        <Button size="sm" variant="outline" disabled={!hasNext || loading} onClick={onNext}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  )
}

/* ── Ticket detail drawer ───────────────────────────────────── */
function TicketDrawer({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const actions = useSupportActions()
  const ticketQ = useTicket(ticketId)
  const data: TicketDetail | null = ticketQ.data ?? null
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(false)
  const [status, setStatus] = useState<TicketStatus>('open')
  const [serverError, setServerError] = useState<string | null>(null)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const savedQ = useSavedResponses()

  useEffect(() => {
    if (data) setStatus(data.ticket.status)
  }, [data])

  if (!ticketId) return null

  const send = () => {
    if (!ticketId || reply.trim().length < 1) return
    actions.reply(ticketId, reply.trim(), internal).mutate(undefined, {
      onError: (e) => setServerError(e.message),
      onSuccess: () => { setServerError(null); setReply('') },
    })
  }

  const openAttachment = async (mediaId: string) => {
    if (!ticketId) return
    try {
      const url = await actions.attachmentUrl(ticketId, mediaId)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch { /* honest failure — no fabricated URL */ }
  }

  const submitRefund = () => {
    const amt = Number(refundAmount)
    if (!ticketId || !Number.isFinite(amt) || amt <= 0 || refundReason.trim().length < 3) return
    actions.requestTicketRefund(ticketId, amt, refundReason.trim()).mutate(undefined, {
      onError: (e) => setServerError(e.message),
      onSuccess: (res) => {
        if (res && typeof res === 'object' && 'status' in res && (res as { status?: string }).status === 'APPROVAL_REQUIRED') {
          setServerError(null)
          void import('@/lib/toast').then(({ toast }) => toast.info('Refund needs an approval — execute it from Approvals'))
        } else {
          setServerError(null)
        }
        setRefundOpen(false)
      },
    })
  }

  const ticket = data?.ticket
  const messages = data?.messages ?? []
  const ownerId = ticket?.ownerId ?? ''

  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose() }} width="lg" title={`Ticket ${ticketId.slice(0, 8)}…`} subtitle={ticket ? `${ticket.category} · created ${fmtDateTime(ticket.createdAt)}` : ''}>
      {ticketQ.isLoading || !ticket ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-14 w-full rounded-xl" />)}</div>
      ) : (
        <div className="space-y-4">
          {/* header */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={ticket.status} dot />
            <Badge tone="blue">{ticket.category}</Badge>
            {ticket.orderId && (
              <Link to={`/orders/${ticket.orderId}`} className="font-mono text-xs font-bold text-brand-700 hover:underline dark:text-brand-300">order {ticket.orderId.slice(0, 8)}…</Link>
            )}
          </div>

          {/* status update */}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
            <span className="text-[12px] font-semibold text-muted-foreground">Status</span>
            <div className="w-44">
              <Select value={status} onValueChange={(v) => setStatus(v as TicketStatus)} options={STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }))} />
            </div>
            <Button size="sm" variant="outline" disabled={status === ticket.status} onClick={() => actions.setStatus(ticketId, status).mutate(undefined, { onError: (e) => setServerError(e.message) })}>
              <Save className="h-3.5 w-3.5" /> Update
            </Button>
          </div>

          {/* messages */}
          <section>
            <h4 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-muted-foreground">Conversation</h4>
            <div className="space-y-2">
              {messages.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No messages</p>}
              {messages.map((m) => (
                <div key={m.id} className={cn('rounded-xl border px-3 py-2.5', m.internal ? 'border-amber-200 bg-warning-soft dark:border-amber-500/30' : 'border-border/70', !m.isOwner && 'bg-muted/30')}>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="font-bold">{m.isOwner ? 'Customer' : m.authorId === ownerId ? 'Customer' : 'Staff'}</span>
                    {m.internal && <Badge tone="amber">internal note</Badge>}
                    <span className="ml-auto text-muted-foreground">{fmtDateTime(m.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{m.body}</p>
                  {(m.attachments ?? []).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(m.attachments ?? []).map((mid) => (
                        <button key={mid} onClick={() => void openAttachment(mid)} className="inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground">
                          <Paperclip className="h-3 w-3" /> attachment
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {data.nextMessagesCursor && (
              <p className="mt-2 text-[11px] text-muted-foreground">Older messages exist on the cursor feed.</p>
            )}
          </section>

          {/* canned responses */}
          {(savedQ.data ?? []).length > 0 && !internal && (
            <div className="flex flex-wrap gap-1.5">
              {(savedQ.data ?? []).slice(0, 5).map((r: SavedResponse) => (
                <button key={r.id} onClick={() => setReply(r.body)} className="rounded-lg bg-primary-softer px-2.5 py-1.5 text-[11.5px] font-semibold text-brand-700 hover:bg-primary-soft dark:text-brand-300">
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* reply */}
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="h-4 w-4 rounded border-input accent-[#2E7D1A]" />
                Internal note (not visible to the customer)
              </label>
            </div>
            <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={internal ? 'Staff-only note…' : 'Reply to the customer…'} />
            {serverError && <p className="mt-2 rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRefundOpen(true)}>
                <Undo2 className="h-3.5 w-3.5" /> Refund
              </Button>
              <Button size="sm" variant="primary" disabled={reply.trim().length < 1} onClick={send}>
                <Send className="h-3.5 w-3.5" /> {internal ? 'Add note' : 'Send reply'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ticket refund dialog */}
      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent title="Ticket refund" description="Amount in ₹ — committed directly or sent for approval by the server">
          <div className="space-y-3">
            <Field label="Amount (₹)" required>
              <Input type="number" min={1} value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
            </Field>
            <Field label="Reason" required>
              <Textarea value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="md" onClick={() => setRefundOpen(false)}>Cancel</Button>
              <Button variant="primary" size="md" disabled={!Number(refundAmount) || refundReason.trim().length < 3} onClick={submitRefund}>
                <Undo2 className="h-4 w-4" /> Submit refund
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Drawer>
  )
}

/* ── Canned response dialog ─────────────────────────────────── */
function CannedDialog({ open, onOpenChange, initial, onSave, serverError }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: SavedResponse | null
  onSave: (values: { id?: string; label: string; body: string; active: boolean }) => void
  serverError: string | null
}) {
  const [label, setLabel] = useState('')
  const [body, setBody] = useState('')
  useEffect(() => {
    if (open) { setLabel(initial?.label ?? ''); setBody(initial?.body ?? '') }
  }, [open, initial])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initial ? 'Edit canned response' : 'New canned response'} description="Quick replies for the support desk">
        <div className="space-y-3">
          <Field label="Label" required><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></Field>
          <Field label="Body" required><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} /></Field>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={!label.trim() || !body.trim()} onClick={() => { onSave({ id: initial?.id, label: label.trim(), body: body.trim(), active: true }); onOpenChange(false) }}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Support() {
  const container = useStagger()
  const actions = useSupportActions()
  const [serverError, setServerError] = useState<string | null>(null)
  const [tab, setTab] = useState<MainTab>('tickets')

  const [ticketsCursor, setTicketsCursor] = useState<string | null>(null)
  const [ticketsStack, setTicketsStack] = useState<Array<string | null>>([null])
  const ticketsQ = useTickets(ticketsCursor ?? undefined)
  const tickets: TicketListItem[] = ticketsQ.data?.items ?? []

  const [ratingsPager, setRatingsPager] = useState<{ cursor: string | null; stack: Array<string | null> }>({ cursor: null, stack: [null] })
  const [queueOnly, setQueueOnly] = useState(true)
  const ratingsQ = useRatings(queueOnly, ratingsPager.cursor ?? undefined)
  const ratings: RatingRow[] = ratingsQ.data?.items ?? []

  const cannedQ = useSavedResponses()
  const canned: SavedResponse[] = cannedQ.data ?? []

  const [detailId, setDetailId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [cannedOpen, setCannedOpen] = useState(false)
  const [editingCanned, setEditingCanned] = useState<SavedResponse | null>(null)

  const filteredTickets = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tickets
    return tickets.filter((t) => t.id.toLowerCase().includes(q) || t.category.toLowerCase().includes(q) || (t.orderId ?? '').toLowerCase().includes(q))
  }, [tickets, search])

  const moderate = (r: RatingRow, hide: boolean) => {
    const reason = hide ? 'Hidden after moderation review (policy violation)' : 'Restored after moderation review'
    actions.moderate(r.id, hide, reason).mutate(undefined, { onError: (e) => setServerError(e.message) })
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Support"
        titleAccent="& reviews"
        subtitle="Customer tickets, canned responses and rating moderation."
        artwork="support"
        breadcrumb={['Support']}
        actions={tab === 'canned' ? (
          <Button variant="primary" size="md" onClick={() => { setEditingCanned(null); setCannedOpen(true) }}>
            <Plus className="h-4 w-4" /> New response
          </Button>
        ) : undefined}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="support-tabs"
            value={tab}
            onChange={(v) => setTab(v as MainTab)}
            tabs={[
              { value: 'tickets', label: 'Tickets', count: tickets.length },
              { value: 'ratings', label: 'Rating moderation', count: ratings.length },
              { value: 'canned', label: 'Canned responses', count: canned.length },
            ]}
          />
        </motion.div>

        {/* ── TICKETS ── */}
        {tab === 'tickets' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchInput value={search} onChange={setSearch} placeholder="Search tickets by id, category or order…" className="min-w-[220px] flex-1" />
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(t) => t.id}
                rows={filteredTickets}
                loading={ticketsQ.isLoading}
                onRowClick={(t) => setDetailId(t.id)}
                empty={<EmptyState icon={LifeBuoy} title="No tickets match" body="Try a different search or clear the filter." />}
                columns={[
                  {
                    key: 'id', header: 'Ticket',
                    render: (t: TicketListItem) => (
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[13px] font-bold">{t.id.slice(0, 8)}…</p>
                        <p className="truncate text-xs text-muted-foreground">{t.category}</p>
                      </div>
                    ),
                  },
                  {
                    key: 'order', header: 'Order',
                    render: (t: TicketListItem) => t.orderId
                      ? <Link to={`/orders/${t.orderId}`} className="font-mono text-xs font-bold text-brand-700 hover:underline dark:text-brand-300">{t.orderId.slice(0, 8)}…</Link>
                      : <span className="text-muted-foreground">—</span>,
                  },
                  { key: 'status', header: 'Status', render: (t: TicketListItem) => <StatusPill status={t.status} dot /> },
                  { key: 'created', header: 'Created', render: (t: TicketListItem) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(t.createdAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: () => (
                      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="outline"><SearchIcon className="h-3.5 w-3.5" /> Open</Button>
                      </div>
                    ),
                  },
                ]}
              />
              <CursorBar
                onPrev={() => setTicketsStack((st) => { if (st.length <= 1) return st; const s = st.slice(0, -1); setTicketsCursor(s[s.length - 1] ?? null); return s })}
                onNext={() => {
                  const nc = ticketsQ.data?.nextCursor ?? null
                  if (!nc) return
                  setTicketsStack((st) => [...st, nc]); setTicketsCursor(nc)
                }}
                hasPrev={ticketsStack.length > 1}
                hasNext={!!ticketsQ.data?.nextCursor}
                loading={ticketsQ.isLoading}
                label={`Page ${ticketsStack.length} · ticket feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── RATINGS ── */}
        {tab === 'ratings' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <p className="text-xs text-muted-foreground">Moderation queue comes from the server (queueOnly)</p>
              <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2">
                <input type="checkbox" checked={queueOnly} onChange={(e) => setQueueOnly(e.target.checked)} className="h-4 w-4 rounded border-input accent-[#2E7D1A]" id="queue-only" />
                <label htmlFor="queue-only" className="cursor-pointer text-[13px] font-medium">Moderation queue only</label>
              </div>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.id}
                rows={ratings}
                loading={ratingsQ.isLoading}
                empty={<EmptyState icon={Star} title="Nothing to moderate" body="Flagged ratings will appear here." />}
                columns={[
                  {
                    key: 'rating', header: 'Rating',
                    render: (r: RatingRow) => (
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map((i) => (
                          <Star key={i} className={cn('h-3.5 w-3.5', i <= r.stars ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
                        ))}
                      </div>
                    ),
                  },
                  { key: 'target', header: 'Target', render: (r: RatingRow) => <Badge tone="blue">{r.targetType.toLowerCase()}</Badge> },
                  { key: 'comment', header: 'Comment', render: (r: RatingRow) => <span className="block max-w-[280px] truncate text-[13px]">{r.comment ?? '—'}</span> },
                  { key: 'state', header: 'State', render: (r: RatingRow) => <StatusPill status={r.hidden ? 'removed' : 'approved'} /> },
                  { key: 'at', header: 'When', render: (r: RatingRow) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (r: RatingRow) => (
                      <div className="flex justify-end gap-1.5">
                        {r.hidden ? (
                          <Tooltip content="Make visible again">
                            <span><Button size="sm" variant="outline" onClick={() => moderate(r, false)}><Eye className="h-3.5 w-3.5" /> Restore</Button></span>
                          </Tooltip>
                        ) : (
                          <Tooltip content="Hide from the storefront">
                            <span><Button size="sm" variant="outline" className="text-destructive" onClick={() => moderate(r, true)}><EyeOff className="h-3.5 w-3.5" /> Hide</Button></span>
                          </Tooltip>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
              <CursorBar
                onPrev={() => setRatingsPager((p) => { if (p.stack.length <= 1) return p; const s = p.stack.slice(0, -1); return { cursor: s[s.length - 1] ?? null, stack: s } })}
                onNext={() => {
                  const nc = ratingsQ.data?.nextCursor ?? null
                  if (!nc) return
                  setRatingsPager((p) => ({ cursor: nc, stack: [...p.stack, nc] }))
                }}
                hasPrev={ratingsPager.stack.length > 1}
                hasNext={!!ratingsQ.data?.nextCursor}
                loading={ratingsQ.isLoading}
                label={`Page ${ratingsPager.stack.length} · ratings feed`}
              />
            </Card>
            {serverError && <p className="text-xs font-semibold text-destructive">{serverError}</p>}
          </motion.section>
        )}

        {/* ── CANNED RESPONSES ── */}
        {tab === 'canned' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.id}
                rows={canned}
                loading={cannedQ.isLoading}
                empty={<EmptyState icon={LifeBuoy} title="No canned responses" body="Save the first quick reply." />}
                columns={[
                  { key: 'label', header: 'Label', render: (r: SavedResponse) => <span className="font-semibold">{r.label}</span> },
                  { key: 'body', header: 'Body', render: (r: SavedResponse) => <span className="block max-w-[420px] truncate text-[13px] text-muted-foreground">{r.body}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (r: SavedResponse) => (
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => { setEditingCanned(r); setCannedOpen(true) }}>
                          <Save className="h-3.5 w-3.5" /> Edit
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}
      </motion.div>

      <TicketDrawer ticketId={detailId} onClose={() => setDetailId(null)} />
      <CannedDialog
        open={cannedOpen}
        onOpenChange={setCannedOpen}
        initial={editingCanned}
        serverError={serverError}
        onSave={(values) => actions.saveCannedResponse(values).mutate(undefined, {
          onError: (e) => setServerError(e.message),
          onSuccess: () => { setServerError(null); setCannedOpen(false) },
        })}
      />
    </div>
  )
}

export default Support

