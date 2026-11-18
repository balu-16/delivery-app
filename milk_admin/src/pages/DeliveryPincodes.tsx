import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/http'
import { addDeliveryPincodes, listDeliveryPincodes, updateDeliveryPincode, type PincodeCoverage } from '@/api/pincodes'
import { useScope, useStores } from '@/hooks/queries'
import { Button, Card, Input, Switch } from '@/components/ui/base'
import { Field, Select } from '@/components/ui/form'
import type { Store } from '@/types'

function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PINCODE_EXISTS') return 'One of these PIN codes already exists. Search for it below to make changes.'
    if (error.code === 'CONCURRENT_MODIFICATION') return 'This PIN code changed elsewhere. Refresh the list and try again.'
    if (error.code === 'STORE_NOT_FOUND') return 'That store no longer exists. Choose another store.'
  }
  return 'Could not save the delivery area. Check your connection and try again.'
}

function PincodeRow({ row, stores, onSaved }: { row: PincodeCoverage; stores: Store[]; onSaved: () => Promise<unknown> }) {
  const [storeId, setStoreId] = useState(row.storeId)
  const [locality, setLocality] = useState(row.locality)
  const [active, setActive] = useState(row.active)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => { setStoreId(row.storeId); setLocality(row.locality); setActive(row.active) }, [row.storeId, row.locality, row.active, row.version])
  const save = useMutation({ mutationFn: () => updateDeliveryPincode(row.id, { storeId, locality: locality.trim(), active, version: row.version }),
    onSuccess: async () => { setError(''); await onSaved(); setSaved(true) }, onError: (cause) => { setSaved(false); setError(message(cause)) } })
  const changed = storeId !== row.storeId || locality !== row.locality || active !== row.active
  return <Card className="space-y-3 p-4">
    <div className="flex items-center justify-between gap-3"><div><p className="font-semibold">{row.pincode}</p><p className="text-xs text-muted-foreground">{row.storeStatus === 'ONLINE' ? 'Store online' : `Store ${row.storeStatus.toLowerCase()} · orders may be unavailable`}</p></div>
      <label className="flex items-center gap-2 text-sm">Enabled <Switch checked={active} disabled={save.isPending} onCheckedChange={(value) => { setSaved(false); setActive(value) }} /></label></div>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Assigned store"><Select ariaLabel={`Assigned store for ${row.pincode}`} value={storeId} onValueChange={(value) => {setSaved(false); setStoreId(value)}} options={stores.map(s => ({value:s.id,label:s.name}))} /></Field>
      <Field label="Area or locality (optional)"><Input aria-label={`Area or locality for ${row.pincode}`} value={locality} maxLength={120} onChange={(e) => {setSaved(false); setLocality(e.target.value)}} /></Field></div>
    <div className="flex items-center gap-3"><Button size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
      {saved && <span role="status" className="text-xs text-brand-700">Saved</span>}{error && <span role="alert" className="text-xs text-destructive">{error}</span>}</div>
  </Card>
}

export function DeliveryPincodes() {
  const scope = useScope()
  const client = useQueryClient()
  const storesQ = useStores()
  const coverage = useQuery({ queryKey: ['delivery-pincodes', scope], queryFn: listDeliveryPincodes })
  const [codes, setCodes] = useState('')
  const [storeId, setStoreId] = useState('')
  const [locality, setLocality] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refresh = () => client.invalidateQueries({ queryKey: ['delivery-pincodes', scope] })
  const add = useMutation({ mutationFn: (pincodes: string[]) => addDeliveryPincodes({ pincodes, storeId, locality: locality.trim() }),
    onSuccess: async (_, pincodes) => { setCodes(''); setError(''); setNotice(`${pincodes.length} PIN ${pincodes.length === 1 ? 'code added' : 'codes added'}.`); await refresh() },
    onError: (cause) => {setNotice(''); setError(message(cause))} })
  const rows = (coverage.data ?? []).filter(row => `${row.pincode} ${row.locality} ${row.storeName}`.toLowerCase().includes(search.trim().toLowerCase()))
  const submit = () => {
    const values = codes.split(/[\s,;]+/).filter(Boolean)
    if (!values.length || values.length > 100 || values.some(value => !/^\d{6}$/.test(value))) {setError('Enter up to 100 six-digit PIN codes, separated by spaces or commas.'); return}
    if (new Set(values).size !== values.length) {setError('Remove repeated PIN codes before saving.'); return}
    if (!storeId) {setError('Choose the store that will deliver these PIN codes.'); return}
    setError(''); setNotice(''); add.mutate(values)
  }
  return <section className="space-y-4">
    <Card className="space-y-4 p-5"><div><h2 className="font-semibold">Delivery PIN codes</h2><p className="text-sm text-muted-foreground">Only enabled PIN codes can place new orders. Each PIN is assigned to one store; its hours and delivery capacity still apply.</p></div>
      <div className="grid gap-3 md:grid-cols-3"><Field label="PIN codes" required><Input aria-label="PIN codes" placeholder="520001, 520002" value={codes} onChange={e => setCodes(e.target.value)} /></Field>
        <Field label="Delivery store" required><Select ariaLabel="Delivery store" value={storeId} onValueChange={setStoreId} options={(storesQ.data ?? []).map(s => ({value:s.id,label:s.name}))} placeholder="Choose a store" /></Field>
        <Field label="Area or locality (optional)"><Input aria-label="Area or locality" value={locality} onChange={e => setLocality(e.target.value)} maxLength={120} /></Field></div>
      <Button onClick={submit} disabled={add.isPending || storesQ.isLoading}>{add.isPending ? 'Adding…' : 'Add PIN codes'}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-brand-700">{notice}</p>}
      {storesQ.isError && <p role="alert" className="text-sm text-destructive">Could not load stores. Refresh the page and try again.</p>}
    </Card>
    <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search PIN, area or store" aria-label="Search delivery PIN codes" />
    {coverage.isLoading && <p role="status">Loading delivery areas…</p>}
    {coverage.isError && <Card className="p-4"><p role="alert">Could not load delivery areas.</p><Button size="sm" onClick={() => void coverage.refetch()}>Try again</Button></Card>}
    {!coverage.isLoading && !coverage.isError && rows.length === 0 && <Card className="p-5 text-sm text-muted-foreground">{search ? 'No matching PIN codes.' : 'No PIN codes are enabled yet. Add one above to start deliveries.'}</Card>}
    {rows.map(row => <PincodeRow key={row.id} row={row} stores={storesQ.data ?? []} onSaved={refresh} />)}
  </section>
}
