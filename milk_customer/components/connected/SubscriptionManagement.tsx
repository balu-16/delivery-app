import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import type { CustomerSubscription } from '@/src/api/customer';
import { useCustomer, type SubscriptionActionRequest } from '@/src/store/customer';
import { ErrorBanner, shared } from './Shared';

type Action = SubscriptionActionRequest['action'];
const validDate = (value:string) => { const parsed = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value; };
export function SubscriptionManagement({subscription, name, onClose}:{subscription:CustomerSubscription; name:string; onClose:()=>void}) {
  const [action, setAction] = useState<Action | null>(null), [from, setFrom] = useState(subscription.next_delivery_date?.slice(0,10) ?? ''), [to, setTo] = useState(''), [error, setError] = useState('');
  const {busy, pendingSubscriptionAction, runSubscriptionAction} = useCustomer();
  const run = async () => {
    if (!action || busy) return;
    if ((action === 'skip' || action === 'pause') && !validDate(from)) {setError('Enter a valid date in YYYY-MM-DD format.');return;}
    if (action === 'pause' && (!validDate(to) || to < from)) {setError('Enter a valid end date after the start date.');return;}
    const body:Record<string,string> = action === 'skip' ? {date:from} : action === 'pause' ? {from,to} : {};
    setError('');
    if (await runSubscriptionAction({id:subscription.id,action,body})) onClose();
  };
  return <BottomSheet visible onClose={onClose} title={name} subtitle={subscription.status.replaceAll('_',' ').toLowerCase()}><View style={{gap:12}}>
    <ErrorBanner />
    <AppText style={shared.muted}>Next delivery: {subscription.next_delivery_date?.slice(0,10) ?? 'not scheduled'}</AppText>
    {pendingSubscriptionAction ? <><AppText style={shared.body}>A subscription change is awaiting confirmation. Check it before making another change.</AppText><Button label="Check or retry change" fullWidth loading={busy} onPress={() => void runSubscriptionAction().then(ok => {if (ok) onClose();})} /></> : ['ACTIVE','PAUSED'].includes(subscription.status) && <><View style={shared.row}><Button label="Skip a delivery" variant="soft" size="sm" onPress={() => {setAction('skip');setError('');}} /><Button label="Pause dates" variant="soft" size="sm" onPress={() => {setAction('pause');setError('');}} /><Button label="Resume" variant="soft" size="sm" onPress={() => {setAction('resume');setError('');}} /><Button label="Cancel" variant="outline" size="sm" onPress={() => {setAction('cancel');setError('');}} /></View>
    {action && <><AppText style={shared.label}>{action === 'skip' ? 'Skip which delivery?' : action === 'pause' ? 'Pause deliveries between these dates' : action === 'resume' ? 'Resume deliveries?' : 'Cancel this subscription?'}</AppText>{(action === 'skip' || action === 'pause') && <TextInput style={shared.input} value={from} onChangeText={setFrom} placeholder={action === 'skip' ? 'Delivery date YYYY-MM-DD' : 'From YYYY-MM-DD'} accessibilityLabel="Delivery or pause start date" />}{action === 'pause' && <TextInput style={shared.input} value={to} onChangeText={setTo} placeholder="To YYYY-MM-DD" accessibilityLabel="Pause end date" />}<AppText style={shared.muted}>Changes are subject to the delivery cutoff and available schedule.</AppText>{!!error && <AppText style={{color:colors.danger}}>{error}</AppText>}<Button label={action === 'cancel' ? 'Confirm cancellation' : action === 'resume' ? 'Confirm resume' : action === 'pause' ? 'Confirm pause' : 'Confirm skip'} fullWidth loading={busy} onPress={() => void run()} /></>}
    </>}
  </View></BottomSheet>;
}
