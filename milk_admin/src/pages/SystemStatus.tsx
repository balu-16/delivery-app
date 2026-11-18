import { useQuery } from '@tanstack/react-query'
import { get } from '@/api/http'
import { Button, Card } from '@/components/ui/base'
import { fmtDateTime } from '@/lib/utils'

type Health = {checks:Array<{name:string;available:boolean}>;assistant:{enabled:boolean|null;runtimeConfigured:boolean;worker:string};push:string}
type History = {id:string;actor:string;action:string;subject:string;details:Record<string,unknown>;occurredAt:string}
const names: Record<string,string> = {database:'Database',redis:'Cache',queue:'Event queue','concern-queues':'Background queues',s3:'File storage'}
const flagNames: Record<string,string> = {customer_location_required:'Customer location requirement',wallet_enabled:'Wallet payments',cod_enabled:'Cash on delivery',agent_enabled:'Customer assistant'}
const readable = (key:string) => flagNames[key] ?? key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ')
export function SystemHealth() {
  const health = useQuery({queryKey:['system-health'],queryFn:()=>get<Health>('/v1/admin/system/health'),enabled:false,retry:false})
  return <Card className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">Service status</h3><p className="text-xs text-muted-foreground">Check whether the services used by this server respond.</p></div><Button size="sm" variant="outline" disabled={health.isFetching} onClick={()=>void health.refetch()}>{health.isFetching ? 'Checking…' : 'Check services'}</Button></div>
    {health.isError && <p role="alert" className="text-sm text-destructive">Could not check service status. The server may be unreachable.</p>}
    {health.data && <div className="space-y-1 text-sm">{health.data.checks.length === 0 && <p>No service checks are configured.</p>}{health.data.checks.map(check=><p key={check.name}>{names[check.name] ?? check.name}: <strong>{check.available ? 'Responding' : 'Unavailable'}</strong></p>)}<p>Assistant: <strong>{health.data.assistant.enabled === null ? 'Status unknown' : !health.data.assistant.enabled ? 'Turned off' : health.data.assistant.runtimeConfigured ? 'Configured' : 'Not configured'}</strong> · {health.data.assistant.worker}</p><p>Push notifications: <strong>{health.data.push}</strong></p><p className="text-xs text-muted-foreground">A configured provider has not been tested for message delivery by this check.</p></div>}
  </Card>
}
export function SettingsHistory() {
  const query = useQuery({queryKey:['settings-history'],queryFn:()=>get<History[]>('/v1/admin/system/history')})
  return <Card className="space-y-3 p-5"><h3 className="font-semibold">Recent changes</h3><p className="text-xs text-muted-foreground">The latest 100 changes to settings, feature switches and delivery PINs.</p>{query.isLoading ? <p role="status">Loading history…</p> : query.isError ? <><p role="alert" className="text-sm text-destructive">Could not load change history.</p><Button size="sm" onClick={()=>void query.refetch()}>Try again</Button></> : !query.data?.length ? <p className="text-sm text-muted-foreground">No changes recorded yet.</p> : query.data.map(row=><div key={row.id} className="border-t border-border/60 py-3 text-sm"><p className="font-semibold">{row.action.startsWith('PINCODE') ? `Delivery PIN ${String(row.details?.pincode ?? (row.details?.before as Record<string,unknown> | undefined)?.pincode ?? '')}` : readable(row.subject)}</p><p className="text-xs text-muted-foreground">{row.actor} · {fmtDateTime(row.occurredAt)}</p>{row.details && 'before' in row.details && <p className="mt-1 break-all text-xs text-muted-foreground">Before: {JSON.stringify(row.details.before)} · After: {JSON.stringify(row.details.after)}</p>}</div>)}</Card>
}
