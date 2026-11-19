import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { FormSkeleton } from '@/components/animations/Skeleton';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { customerDetailsApi, type CatalogItem, type SubscriptionOptions } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { colors } from '@/constants/theme';
import { ErrorBanner, shared } from './Shared';

export function SubscriptionPanel({item, addressId, onClose}:{item:CatalogItem; addressId:string; onClose:()=>void}) {
  const [result, setResult] = useState<{key:string; options:SubscriptionOptions | null} | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const loadKey = `${addressId}:${item.variantId}:${attempt}`;
  const loading = result?.key !== loadKey;
  const options = !loading ? result?.options : null;
  const [slot, setSlot] = useState(''), [start, setStart] = useState(''), [quantity, setQuantity] = useState(1), [frequency, setFrequency] = useState<'DAILY' | 'ALTERNATE_DAYS'>('DAILY');
  const {busy, pendingSubscription, createSubscription} = useCustomer();
  useEffect(() => {
    let active = true;
    void accessToken().then(token => customerDetailsApi.subscriptionOptions(token,addressId,item.variantId)).then(value => {
      if (active) { setResult({key:loadKey, options:value}); setStart(value.firstStartDate); setSlot(value.slots[0]?.id ?? ''); }
    }).catch(() => { if (active) setResult({key:loadKey, options:null}); });
    return () => {active = false;};
  }, [addressId,item.variantId,loadKey]);
  const submit = async () => {
    const parsed = new Date(`${start}T00:00:00Z`);
    if (!options || !slot || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== start || start < options.firstStartDate) { setError('Choose a delivery slot and a valid start date.'); return; }
    const ok = await createSubscription({variantId:item.variantId, quantity:String(quantity), frequencyRule:{type:frequency}, startDate:start, slotId:slot, addressId});
    if (ok) {onClose(); router.push('/my-dairy');}
  };
  return <BottomSheet visible onClose={onClose} title={`Subscribe to ${item.name}`} subtitle={item.variantName}><View style={{gap:12}}><ErrorBanner />{!!error && <AppText style={{color:colors.danger}}>{error}</AppText>}
    {loading ? <FormSkeleton label="Loading delivery options" /> : !options ? <><AppText style={shared.muted}>Couldn’t load subscription options.</AppText><Button label="Try again" variant="soft" onPress={() => { setError(''); setAttempt(value => value + 1); }} /></> : !options.enabled ? <AppText style={shared.body}>Subscriptions are not available at the moment.</AppText> : !options.eligible || !options.slots.length ? <AppText style={shared.body}>This product does not currently have subscription slots at this address.</AppText> : <>
      {pendingSubscription ? <><AppText style={shared.body}>A subscription request is awaiting confirmation. Check it before starting another.</AppText><Button label="Go to My Dairy" variant="soft" fullWidth onPress={() => {onClose(); router.push('/my-dairy');}} /></> : <>
      <AppText style={shared.label}>How often?</AppText><View style={shared.row}><Button label="Daily" size="sm" variant={frequency === 'DAILY' ? 'primary' : 'soft'} onPress={() => setFrequency('DAILY')} /><Button label="Alternate days" size="sm" variant={frequency === 'ALTERNATE_DAYS' ? 'primary' : 'soft'} onPress={() => setFrequency('ALTERNATE_DAYS')} /></View>
      <AppText style={shared.label}>Quantity per delivery</AppText><View style={shared.row}><Button label="−" size="sm" variant="soft" onPress={() => setQuantity(n => Math.max(1,n-1))} /><AppText style={shared.label}>{quantity}</AppText><Button label="+" size="sm" variant="soft" onPress={() => setQuantity(n => Math.min(Math.max(1,item.maxPerOrder),n+1))} /></View>
      <AppText style={shared.label}>Delivery time</AppText><View style={shared.row}>{options.slots.map(value => <Button key={value.id} label={`${value.name} ${value.startTime}–${value.endTime}`} size="sm" variant={slot === value.id ? 'primary' : 'soft'} onPress={() => setSlot(value.id)} />)}</View>
      <AppText style={shared.label}>Start date</AppText><TextInput style={shared.input} value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" accessibilityLabel="Subscription start date" /><AppText style={shared.muted}>Earliest start: {options.firstStartDate}. Each delivery is paid from your wallet at the current price.</AppText>
      <Button label="Start subscription" fullWidth onPress={() => void submit()} loading={busy} disabled={!slot} />
      </>}
    </>}
  </View></BottomSheet>;
}
