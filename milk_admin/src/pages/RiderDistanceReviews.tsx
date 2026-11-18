import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { get, post } from '@/api/http'
import { Button, Card, Input } from '@/components/ui/base'
import { fmtDateTime } from '@/lib/utils'

type Review = {earningId:string;orderId:string;riderId:string;riderName:string;createdAt:string;ratePaise:string}
function ReviewRow({row,refresh}: {row:Review;refresh:()=>Promise<unknown>}) {
  const [distance,setDistance] = useState('')
  const [reason,setReason] = useState('')
  const [error,setError] = useState('')
  const [success,setSuccess] = useState(false)
  const review = useMutation({mutationFn:() => post<void>(`/v1/admin/rider-distance-reviews/${encodeURIComponent(row.earningId)}`,{distanceMetres:Number(distance),reason:reason.trim()}),onSuccess:async()=>{setSuccess(true);setError('');await refresh()},onError:()=>setError('Could not save the distance. Refresh and check whether it was already recorded.')})
  const submit = () => {
    if (!/^\d+$/.test(distance) || Number(distance)>500000) {setError('Enter a distance between 0 and 500,000 metres.');return}
    if (!reason.trim()) {setError('Enter how the distance was confirmed.');return}
    const amount = BigInt(Math.floor((Number(distance)+500)/1000))*BigInt(row.ratePaise)
    if (!window.confirm(`Record ${distance} metres and add ₹${amount / 100n}.${String(amount % 100n).padStart(2,'0')} to a future payout?`)) return
    setError(''); review.mutate()
  }
  return <Card className="space-y-3 p-4"><div><p className="font-semibold">{row.riderName}</p><p className="text-xs text-muted-foreground">Order {row.orderId.slice(0,8)}… · {fmtDateTime(row.createdAt)} · distance rate ₹{(BigInt(row.ratePaise)/100n).toString()}.{String(BigInt(row.ratePaise)%100n).padStart(2,'0')} per km</p></div>
    <p className="text-xs text-muted-foreground">Base, waiting pay and tips are already recorded. This records distance pay for a future payout; it does not transfer money.</p>
    <div className="flex flex-wrap gap-2"><Input className="w-44" inputMode="numeric" value={distance} onChange={e=>setDistance(e.target.value)} placeholder="Distance in metres" aria-label="Distance in metres" /><Input className="min-w-56 flex-1" value={reason} onChange={e=>setReason(e.target.value)} maxLength={300} placeholder="How was the distance confirmed?" aria-label="Reason" /><Button size="sm" disabled={review.isPending} onClick={submit}>{review.isPending ? 'Saving…' : 'Review distance'}</Button></div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}{success && <p role="status" className="text-xs text-brand-700">Distance recorded.</p>}</Card>
}
export function RiderDistanceReviews() {
  const client = useQueryClient()
  const query = useQuery({queryKey:['rider-distance-reviews'],queryFn:()=>get<Review[]>('/v1/admin/rider-distance-reviews')})
  return <section className="space-y-3"><h2 className="font-semibold">Distance pay to review</h2>{query.isLoading ? <p role="status" className="text-sm">Loading reviews…</p> : query.isError ? <p role="alert" className="text-sm text-destructive">Could not load distance reviews.</p> : !query.data?.length ? <p className="text-sm text-muted-foreground">No distance payments need review.</p> : query.data.map(row=><ReviewRow key={row.earningId} row={row} refresh={()=>client.invalidateQueries({queryKey:['rider-distance-reviews']})} />)}</section>
}
