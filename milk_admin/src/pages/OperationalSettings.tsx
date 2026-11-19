import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateConfigKey } from '@/api/settings'
import { Button, Card, Input, Switch } from '@/components/ui/base'

type Kind = 'money' | 'integer' | 'time' | 'boolean'
type Setting = { key: string; label: string; hint: string; kind: Kind }
const groups: Array<{ title: string; items: Setting[] }> = [
  { title: 'Orders and fees', items: [
    {key:'minOrderPaise',label:'Minimum order',hint:'Smallest permitted order value',kind:'money'},
    {key:'maxOrderPaise',label:'Maximum order',hint:'Largest permitted order value',kind:'money'},
    {key:'maxCodPaise',label:'Cash on delivery limit',hint:'Maximum cash due on one order',kind:'money'},
    {key:'freeDeliveryThresholdPaise',label:'Free delivery from',hint:'Qualifying order value',kind:'money'},
    {key:'handlingFeePaise',label:'Handling fee',hint:'Fee applied to an order',kind:'money'},
    {key:'smallCartThresholdPaise',label:'Small order threshold',hint:'Orders below this value may have a small-order fee',kind:'money'},
    {key:'smallCartFeePaise',label:'Small order fee',hint:'Fee below the small order threshold',kind:'money'},
    {key:'surgeFeePaise',label:'Surge fee',hint:'Extra fee applied only while surge pricing is enabled',kind:'money'},
    {key:'catalogMaxPerOrder',label:'Maximum quantity per product',hint:'Maximum units of one product in a cart',kind:'integer'},
    {key:'maxCartLines',label:'Maximum different cart items',hint:'Maximum number of products in a cart',kind:'integer'},
  ]},
  { title:'Delivery partners', items: [
    {key:'offerTimeoutSeconds',label:'Offer response time',hint:'Seconds to accept a delivery offer',kind:'integer'},
    {key:'riderMaxConcurrentTasks',label:'Maximum active deliveries',hint:'Maximum assignments per delivery partner',kind:'integer'},
    {key:'cashInHandLimitPaise',label:'Cash-in-hand limit',hint:'New cash assignments are restricted at the limit',kind:'money'},
    {key:'earningsBasePaise',label:'Base delivery pay',hint:'Base earning for a completed delivery',kind:'money'},
    {key:'earningsPerKmPaise',label:'Distance pay per kilometre',hint:'Additional distance earning',kind:'money'},
    {key:'detentionFreeMinutes',label:'Free waiting time',hint:'Minutes before waiting pay starts',kind:'integer'},
    {key:'detentionPerMinutePaise',label:'Waiting pay per minute',hint:'Pay for eligible extra waiting',kind:'money'},
    {key:'deliveryFailureWaitSeconds',label:'Unavailable customer wait',hint:'Required waiting time in seconds',kind:'integer'},
    {key:'deliveryFailureMinContactAttempts',label:'Minimum contact attempts',hint:'Attempts before recording customer unavailable',kind:'integer'},
  ]},
  { title:'Assistant and notifications', items: [
    {key:'agent_proactive_nudges_enabled',label:'Reorder reminders',hint:'Reminders are sent only to customers who opt in',kind:'boolean'},
    {key:'agent_nudge_max_per_week',label:'Maximum reminders per week',hint:'Limit per opted-in customer',kind:'integer'},
    {key:'agent_daily_turn_limit_per_user',label:'Assistant messages per day',hint:'Maximum per customer',kind:'integer'},
    {key:'notificationQuietHoursStart',label:'Quiet hours start',hint:'Promotional notifications wait until quiet hours end',kind:'time'},
    {key:'notificationQuietHoursEnd',label:'Quiet hours end',hint:'India time',kind:'time'},
  ]},
  { title:'Stock and support', items: [
    {key:'catalogLowStockThreshold',label:'Low-stock alert',hint:'Available units at which stock is considered low',kind:'integer'},
    {key:'inventoryExpirySoonDays',label:'Expiry warning',hint:'Days before a product expires',kind:'integer'},
    {key:'supportFirstResponseSlaHours',label:'First support response target',hint:'Hours after a request is submitted',kind:'integer'},
    {key:'supportResolutionSlaHours',label:'Support resolution target',hint:'Hours to resolve a request',kind:'integer'},
    {key:'supportReopenDays',label:'Reopen support requests',hint:'Days after closing a request',kind:'integer'},
  ]},
]

function display(value: unknown, kind: Kind): string {
  if (kind === 'money' && typeof value === 'string' && /^\d+$/.test(value)) {const n = BigInt(value); return `${n / 100n}.${String(n % 100n).padStart(2,'0')}`}
  if (kind === 'time' && typeof value === 'number') return `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(value % 60).padStart(2,'0')}`
  return String(value ?? '')
}
function parse(value: string, kind: Kind): string | number {
  if (kind === 'money') { if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter a valid amount with up to two decimal places.'); const [whole, fraction = ''] = value.split('.'); const paise = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2,'0')); if (paise > 9223372036854775807n) throw new Error('This amount is too large.'); return paise.toString() }
  if (kind === 'time') {if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Enter a valid time.'); const [hours, minutes] = value.split(':').map(Number); return hours! * 60 + minutes!}
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Enter a whole number.')
  return Number(value)
}
const integerRanges: Record<string, [number,number]> = {
  catalogMaxPerOrder:[1,Number.MAX_SAFE_INTEGER], maxCartLines:[1,Number.MAX_SAFE_INTEGER],
  offerTimeoutSeconds:[1,3600], riderMaxConcurrentTasks:[1,20], detentionFreeMinutes:[0,1440],
  deliveryFailureWaitSeconds:[0,86400], deliveryFailureMinContactAttempts:[1,20],
  agent_nudge_max_per_week:[0,7], agent_daily_turn_limit_per_user:[1,10000],
  catalogLowStockThreshold:[1,Number.MAX_SAFE_INTEGER], inventoryExpirySoonDays:[1,Number.MAX_SAFE_INTEGER],
  supportFirstResponseSlaHours:[1,720], supportResolutionSlaHours:[1,2160], supportReopenDays:[0,90],
}
function SettingRow({setting, value, config}: {setting: Setting; value: unknown; config: Record<string, unknown>}) {
  const client = useQueryClient()
  const [raw, setRaw] = useState(() => display(value,setting.kind))
  const [enabled, setEnabled] = useState(value === true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {setRaw(display(value,setting.kind)); setEnabled(value === true)},[value,setting.kind])
  const mutation = useMutation({mutationFn: (next: unknown) => updateConfigKey(setting.key,next), onSuccess: async () => {await client.invalidateQueries({queryKey:['config']}); setError(''); setSaved(true)}, onError: (cause) => setError(cause instanceof Error ? cause.message : 'Could not save this setting.')})
  const save = () => {try {
    setError(''); setSaved(false)
    const next = setting.kind === 'boolean' ? enabled : parse(raw,setting.kind)
    const range = integerRanges[setting.key]
    if (range && typeof next === 'number' && (next < range[0] || next > range[1])) throw new Error(`Enter a whole number between ${range[0]} and ${range[1]}.`)
    if (setting.key === 'minOrderPaise' && typeof next === 'string' && typeof config.maxOrderPaise === 'string' && BigInt(next) > BigInt(config.maxOrderPaise)) throw new Error('The minimum cannot be greater than the maximum order.')
    if (setting.key === 'maxOrderPaise' && typeof next === 'string' && typeof config.minOrderPaise === 'string' && BigInt(next) < BigInt(config.minOrderPaise)) throw new Error('The maximum cannot be less than the minimum order.')
    if (setting.key === 'supportFirstResponseSlaHours' && typeof next === 'number' && typeof config.supportResolutionSlaHours === 'number' && next > config.supportResolutionSlaHours) throw new Error('The first response target cannot be later than the resolution target.')
    if (setting.key === 'supportResolutionSlaHours' && typeof next === 'number' && typeof config.supportFirstResponseSlaHours === 'number' && next < config.supportFirstResponseSlaHours) throw new Error('The resolution target cannot be earlier than the first response target.')
    mutation.mutate(next)
  } catch (cause) {setError(cause instanceof Error ? cause.message : 'Check this value.')}}
  return <div className="flex flex-wrap items-end gap-3 border-t border-border/60 py-3 first:border-0"><div className="min-w-56 flex-1"><p className="text-sm font-semibold">{setting.label}</p><p className="text-xs text-muted-foreground">{setting.hint}</p>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}{saved && <p role="status" className="text-xs text-brand-700">Saved</p>}</div>
    {setting.kind === 'boolean' ? <Switch checked={enabled} onCheckedChange={setEnabled} /> : <label className="flex items-center gap-1 text-sm">{setting.kind === 'money' && '₹'}<Input type={setting.kind === 'time' ? 'time' : 'text'} inputMode={setting.kind === 'money' ? 'decimal' : 'numeric'} aria-label={setting.label} className="w-32" value={raw} onChange={e => {setSaved(false); setRaw(e.target.value)}} /></label>}
    <Button size="sm" variant="outline" disabled={mutation.isPending || value === undefined} onClick={save}>{mutation.isPending ? 'Saving…' : 'Save'}</Button></div>
}
type Slab = {maxOrderValuePaise: string | null; feePaise: string}
function FeeSlabs({value}: {value: unknown}) {
  const client = useQueryClient()
  const [rows, setRows] = useState<Array<{ceiling:string; fee:string}>>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {if (Array.isArray(value)) setRows((value as Slab[]).map(row => ({ceiling:row.maxOrderValuePaise === null ? '' : display(row.maxOrderValuePaise,'money'),fee:display(row.feePaise,'money')})))},[value])
  const mutation = useMutation({mutationFn:(next:Slab[]) => updateConfigKey('deliveryFeeSlabs',next),onSuccess:async()=>{await client.invalidateQueries({queryKey:['config']});setError('');setSaved(true)},onError:(cause)=>setError(cause instanceof Error ? cause.message : 'Could not save delivery fees.')})
  const change = (index:number, field:'ceiling'|'fee', text:string) => {setSaved(false);setRows(current => current.map((row,i) => i === index ? {...row,[field]:text} : row))}
  const save = () => {try {if (!rows.length || rows.length > 20) throw new Error('Add between 1 and 20 fee ranges.'); let previous = -1n; const next = rows.map((row,i) => {const ceiling = row.ceiling.trim() ? String(parse(row.ceiling,'money')) : null; if (ceiling === null && i !== rows.length-1) throw new Error('Only the last range can be open-ended.'); if (ceiling !== null && BigInt(ceiling) <= previous) throw new Error('Order limits must increase in each range.'); if (ceiling !== null) previous = BigInt(ceiling); return {maxOrderValuePaise:ceiling,feePaise:String(parse(row.fee,'money'))}}); setError('');setSaved(false);mutation.mutate(next)} catch (cause) {setError(cause instanceof Error ? cause.message : 'Check the fee ranges.')}}
  return <Card className="space-y-3 p-5"><h3 className="font-semibold">Delivery fee ranges</h3><p className="text-xs text-muted-foreground">Set each order-value limit and its delivery fee. Leave the final limit empty for all larger orders.</p>{rows.map((row,index) => <div key={index} className="flex flex-wrap items-center gap-2 text-sm"><span>Up to ₹</span><Input className="w-28" value={row.ceiling} onChange={e=>change(index,'ceiling',e.target.value)} aria-label={`Order limit ${index+1}`} placeholder="No limit" /><span>Fee ₹</span><Input className="w-28" value={row.fee} onChange={e=>change(index,'fee',e.target.value)} aria-label={`Delivery fee ${index+1}`} /><Button variant="outline" size="sm" disabled={rows.length <= 1} onClick={()=>setRows(current=>current.filter((_,i)=>i!==index))}>Remove</Button></div>)}
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={rows.length >= 20} onClick={()=>setRows(current=>[...current,{ceiling:'',fee:'0.00'}])}>Add range</Button><Button size="sm" disabled={mutation.isPending} onClick={save}>{mutation.isPending ? 'Saving…' : 'Save fees'}</Button></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}{saved && <p role="status" className="text-xs text-brand-700">Saved</p>}</Card>
}
export function OperationalSettings({config}: {config: Record<string, unknown>}) {
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">These settings apply across the business. Store-specific hours and capacity are managed under Stores.</p><FeeSlabs value={config.deliveryFeeSlabs} />{groups.map(group => <Card key={group.title} className="px-5 py-3"><h3 className="pb-2 font-semibold">{group.title}</h3>{group.items.map(setting => <SettingRow key={setting.key} setting={setting} value={config[setting.key]} config={config} />)}</Card>)}</div>
}
