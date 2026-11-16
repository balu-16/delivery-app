import { firstFailedQuery, PageLoadError } from '@/components/PageLoadError'
// §6 COD Cash Deposits — today's KPIs, rider cash handover form (the backend
// derives the deposit reference and reconciliation outcome) and deposit history.
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Banknote, CheckCircle2, ClipboardList, RefreshCcw } from 'lucide-react'
import { useDebouncedValue, useStagger } from '@dairydirect/shared/hooks/misc'
import { useActiveStoreId, useCodDeposits, useCodRiders } from '@/api/storeQueries'
import { useCodActions } from '@/api/storeMutations'
import { istDayKey } from '@/api/storeApi'
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@dairydirect/shared/ui/base'
import { ConfirmDialog } from '@dairydirect/shared/ui/overlays'
import { Field, Select } from '@dairydirect/shared/ui/form'
import { EmptyState, PageHeader, SearchInput } from '@dairydirect/shared/ui/misc'
import { DataTable, Pagination, type Column } from '@dairydirect/shared/ui/DataTable'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { InitialAvatar } from '@dairydirect/shared/assets/avatars'
import { cn, fmtDateTime, fmtINR } from '@dairydirect/shared/lib/utils'
import type { CodDeposit, DepositOutcome } from '@dairydirect/shared/types'

const PAGE_SIZE = 6

const OUTCOME_STYLE: Record<DepositOutcome, { cls: string; dot: string; label: string }> = {
  received: { cls: 'bg-success-soft text-success', dot: 'bg-success', label: 'Received' },
  pending_verification: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning', label: 'Pending Verification' },
  discrepancy: { cls: 'bg-destructive-soft text-destructive', dot: 'bg-destructive', label: 'Discrepancy' },
}
function OutcomePill({ outcome }: { outcome: DepositOutcome }) {
  const s = OUTCOME_STYLE[outcome]
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold', s.cls)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} /> {s.label}
    </span>
  )
}

export function StoreCodDeposits() {
  const storeId = useActiveStoreId()
  const stagger = useStagger()
  const cod = useCodActions()

  const [search, setSearch] = useState('')
  const debounced = useDebouncedValue(search)
  const [page, setPage] = useState(1)

  const [riderId, setRiderId] = useState('')
  const [amount, setAmount] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const ridersQ = useCodRiders(storeId)
  const history = useCodDeposits(storeId)
  const riders = ridersQ.data ?? []
  const allRows = history.data ?? []

  const rows = useMemo(() => {
    const q = debounced.trim().toLowerCase()
    if (!q) return allRows
    return allRows.filter((d) =>
      d.riderName.toLowerCase().includes(q) ||
      d.id.toLowerCase().includes(q) ||
      d.reference.toLowerCase().includes(q))
  }, [allRows, debounced])

  useEffect(() => { setPage(1) }, [debounced])

  const todayKey = istDayKey(new Date().toISOString())
  const today = allRows.filter((d) => istDayKey(d.at) === todayKey)
  const todayTotal = today.reduce((sum, d) => sum + d.amount, 0)

  const parsedAmount = Number(amount)
  const amountInvalid = amount.trim() === '' || Number.isNaN(parsedAmount) || parsedAmount <= 0
  const rider = riders.find((r) => r.id === riderId) ?? null
  const valid = !!rider && !amountInvalid

  const resetForm = () => { setRiderId(''); setAmount('') }

  const record = () => {
    if (!valid || !rider) return
    void cod.record(rider.id, rider.name, parsedAmount)
    setConfirmOpen(false)
    resetForm()
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const columns: Column<CodDeposit>[] = [
    {
      key: 'id', header: 'Deposit ID',
      render: (d) => <span className="font-semibold tabular" title={d.id}>{d.id.slice(0, 8).toUpperCase()}</span>,
    },
    {
      key: 'rider', header: 'Rider',
      render: (d) => (
        <span className="flex items-center gap-2.5">
          <InitialAvatar name={d.riderName} size={28} />
          <span className="font-medium">{d.riderName}</span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount (₹)', align: 'right', render: (d) => <span className={cn('font-bold tabular', d.amount < 0 && 'text-destructive')}>{fmtINR(d.amount)}</span> },
    { key: 'at', header: 'Deposited At', render: (d) => <span className="whitespace-nowrap text-muted-foreground">{fmtDateTime(d.at)}</span> },
    { key: 'outcome', header: 'Outcome', render: (d) => <OutcomePill outcome={d.outcome} /> },
  ]

  const loadFailure = firstFailedQuery([ridersQ, history])
  if (loadFailure) return <PageLoadError title="COD Cash Deposits" artwork="codDeposits" query={loadFailure} />

  return (
    <motion.div variants={stagger.container} initial="hidden" animate="show" className="space-y-5">
      <PageHeader
        breadcrumb={['COD Cash Deposits']}
        title="COD Cash"
        titleAccent="Deposits"
        subtitle="Record cash handed over by riders. The backend derives the deposit reference and reconciliation outcome."
        artwork="codDeposits"
      />

      <motion.section variants={stagger.item} className="grid gap-4 sm:grid-cols-2 xl:max-w-2xl">
        <KpiCard label="Deposits Today" value={todayTotal} format="compact" icon={Banknote} tint="green" />
        <KpiCard label="No. of Deposits" value={today.length} icon={ClipboardList} tint="blue" />
      </motion.section>

      <motion.section variants={stagger.item} className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* ── Record deposit ── */}
        <Card hoverable className="lg:col-span-5">
          <CardHeader><CardTitle className="flex items-center gap-2"><Banknote className="h-4 w-4 text-brand-600" /> Record COD Cash Deposit</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Field label="Store" required>
              <Select
                value={storeId ?? ''}
                onValueChange={() => {}}
                disabled
                options={[{ value: storeId ?? '', label: cod.storeName }]}
              />
            </Field>

            <Field
              label="Rider"
              required
              error={!riderId && riders.length > 0 ? 'Pick the rider handing over cash' : undefined}
              hint={riders.length === 0 ? 'No riders with delivery activity or COD settlements at this store yet.' : undefined}
            >
              <Select
                value={riderId}
                onValueChange={setRiderId}
                placeholder={ridersQ.isLoading ? 'Loading riders…' : 'Riders with COD activity…'}
                options={riders.map((r) => ({
                  value: r.id,
                  label: `${r.name} · ${fmtINR(r.cashInHand)} in hand${r.hasOutstanding ? ' · outstanding' : ''}`,
                }))}
              />
            </Field>

            <Field label="Deposit Amount (₹)" required error={amountInvalid && amount !== '' ? 'Amount must be greater than 0' : undefined}>
              <Input
                type="number" min={1} step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 4500"
                aria-label="Deposit amount"
              />
            </Field>

            <p className="rounded-lg bg-muted px-3 py-2 text-[11.5px] font-medium text-muted-foreground">
              The deposit reference and received/discrepancy outcome are derived server-side from the rider's cash ledger.
            </p>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={resetForm}><RefreshCcw className="h-4 w-4" /> Clear</Button>
              <Button disabled={!valid} onClick={() => setConfirmOpen(true)}>
                <CheckCircle2 className="h-4 w-4" /> Record Deposit
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Deposit history ── */}
        <Card hoverable className="lg:col-span-7">
          <CardHeader className="flex-wrap">
            <CardTitle>Deposit History ({rows.length})</CardTitle>
            <SearchInput value={search} onChange={setSearch} placeholder="Search by rider, deposit ID or reference…" className="w-full sm:w-72" />
          </CardHeader>
          <CardContent>
            <DataTable
              columns={columns}
              rows={pageRows}
              keyId={(d) => d.id}
              loading={history.isLoading}
              skeletonRows={6}
              empty={<EmptyState icon={Banknote} title="No deposits found" body="Recorded cash deposits will appear here for reconciliation." />}
            />
            <Pagination
              page={page}
              totalPages={totalPages}
              onChange={setPage}
              showing={`Showing ${rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, rows.length)} of ${rows.length} deposits`}
            />
          </CardContent>
        </Card>
      </motion.section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Record this deposit?"
        description={rider ? `${fmtINR(parsedAmount || 0)} from ${rider.name}. The backend will reconcile it against the rider's cash ledger.` : ''}
        confirmLabel="Record Deposit"
        onConfirm={record}
      />
    </motion.div>
  )
}
