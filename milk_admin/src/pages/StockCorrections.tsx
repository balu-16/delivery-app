import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, buildQuery, get, newIdempotencyKey, sendIdempotent } from '@/api/http'
import { useScope } from '@/hooks/queries'
import { Button, Card, Input } from '@/components/ui/base'
import { Select } from '@/components/ui/form'
import type { Store } from '@/types'
import { useAuth } from '@/store/auth'
import { toast } from '@/lib/toast'

type Batch = {batchId:string;variantId:string;productName:string;variantName:string;batchCode:string;state:string;onHand:string;reserved:string;version:string}
type BatchPage = {items:Batch[];nextCursor:string|null}
function BatchRow({row,storeId,refresh}:{row:Batch;storeId:string;refresh:()=>Promise<unknown>}) {
  const [counted,setCounted] = useState(row.onHand), [reason,setReason] = useState(''), [error,setError] = useState('')
  const mutation = useMutation({mutationFn:async()=>{
    const input={storeId,variantId:row.variantId,batchId:row.batchId,counted,expectedVersion:row.version,reason:reason.trim()}
    const body=JSON.stringify([useAuth.getState().admin?.id,input]);let hash=14695981039346656037n
    for(const char of body) hash=BigInt.asUintN(64,(hash ^ BigInt(char.charCodeAt(0)))*1099511628211n)
    const storageKey=`dairydirect:stock-correction:${hash.toString(16)}`
    let key=window.localStorage.getItem(storageKey);if(!key){key=newIdempotencyKey();window.localStorage.setItem(storageKey,key)}
    await sendIdempotent('POST','/v1/admin/inventory/corrections',input,key)
    window.localStorage.removeItem(storageKey)
  },onSuccess:async()=>{setError('');setReason('');toast.success('Stock count updated.');await refresh()},onError:(cause)=>setError(cause instanceof ApiError && cause.code === 'INVENTORY_RESERVED' ? 'Some units are reserved. Refresh the batch and enter a count at least as high as the reserved quantity.' : cause instanceof ApiError && cause.code === 'BATCH_NOT_ELIGIBLE' ? 'This batch is inactive or expired; its stock cannot be increased.' : 'Could not save this count. Refresh the batch and check whether another change was made.')})
  const submit=()=>{
    if(!/^(0|[1-9]\d{0,18})$/.test(counted)){setError('Enter a whole number of units.');return}
    if(BigInt(counted)<BigInt(row.reserved)){setError(`The count cannot be below ${row.reserved} reserved units.`);return}
    if(!reason.trim()){setError('Enter a reason for this correction.');return}
    if(counted===row.onHand){setError('The count has not changed.');return}
    if(!window.confirm(`Set ${row.productName} (${row.batchCode}) from ${row.onHand} to ${counted} units?`)) return
    setError('');mutation.mutate()
  }
  return <Card className="space-y-3 p-4"><div><p className="font-semibold">{row.productName} · {row.variantName}</p><p className="text-xs text-muted-foreground">Batch {row.batchCode} · {row.state.toLowerCase()} · {row.onHand} on hand · {row.reserved} reserved</p></div>
    <div className="flex flex-wrap gap-2"><Input className="w-40" inputMode="numeric" value={counted} onChange={e=>setCounted(e.target.value)} aria-label="Actual units in batch" /><Input className="min-w-56 flex-1" value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} placeholder="Reason for correction" aria-label="Reason for correction" /><Button size="sm" disabled={mutation.isPending} onClick={submit}>{mutation.isPending ? 'Saving…' : 'Save count'}</Button></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</Card>
}
export function StockCorrections({stores}:{stores:Store[]}) {
  const scope=useScope(), client=useQueryClient()
  const [storeId,setStoreId]=useState(''),[cursor,setCursor]=useState<string|null>(null),[stack,setStack]=useState<Array<string|null>>([null])
  const query=useQuery({queryKey:['admin-stock-batches',scope,storeId,cursor],queryFn:()=>get<BatchPage>(`/v1/admin/inventory/batches${buildQuery({storeId,cursor})}`),enabled:!!storeId})
  const refresh=()=>client.invalidateQueries({queryKey:['admin-stock-batches',scope,storeId]})
  return <section className="space-y-3"><Card className="space-y-2 p-5"><h3 className="font-semibold">Correct a stock count</h3><p className="text-sm text-muted-foreground">Select a store and enter the actual units in a batch. Reserved units remain protected and every correction records the reason.</p><div className="max-w-xs"><Select ariaLabel="Store for stock correction" value={storeId} onValueChange={value=>{setStoreId(value);setCursor(null);setStack([null])}} options={stores.map(store=>({value:store.id,label:store.name}))} placeholder="Choose a store" /></div></Card>
    {query.isLoading && storeId && <p role="status">Loading batches…</p>}{query.isError && <p role="alert" className="text-sm text-destructive">Could not load batches. Choose the store again or refresh.</p>}{query.data?.items.length===0 && <p className="text-sm text-muted-foreground">No stock batches for this store.</p>}{query.data?.items.map(row=><BatchRow key={`${row.batchId}:${row.version}`} row={row} storeId={storeId} refresh={refresh} />)}
    {query.data && <div className="flex gap-2"><Button size="sm" variant="outline" disabled={stack.length<2} onClick={()=>{const next=stack.slice(0,-1);setStack(next);setCursor(next[next.length-1] ?? null)}}>Previous</Button><Button size="sm" variant="outline" disabled={!query.data.nextCursor} onClick={()=>{const next=query.data?.nextCursor;if(next){setStack(current=>[...current,next]);setCursor(next)}}}>Next</Button></div>}</section>
}
