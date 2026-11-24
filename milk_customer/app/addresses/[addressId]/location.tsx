import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { UUID_RE } from '@/src/utils/order-groups';

export default function LocationConfirmPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ addressId?: string }>();
  const id = typeof params.addressId === 'string' && UUID_RE.test(params.addressId) ? params.addressId : null;
  const addresses = useCustomer(s => s.addresses);
  const confirmAddressLocation = useCustomer(s => s.confirmAddressLocation);
  const busy = useCustomer(s => s.addressBusy);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [device, setDevice] = useState('');
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  if (!id) return (
    <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
      <PageHeader title="Confirm location" onBack={() => router.back()} />
      <Card><AppText style={shared.body}>Address not found.</AppText></Card>
    </ScrollView></Screen>
  );

  const addr = addresses.find(a => a.id === id);
  if (!addr) return (
    <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
      <PageHeader title="Confirm location" onBack={() => router.back()} />
      <CardListSkeleton count={1} label="Loading address" />
    </ScrollView></Screen>
  );

  const locate = async () => {
    setError(''); setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') throw new Error('Allow location access in your phone settings, then try again.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setDevice(`Current location${pos.coords.accuracy ? ` (about ${Math.round(pos.coords.accuracy)} m accuracy)` : ''}`);
    } catch (cause) {
      setPoint(null); setDevice('');
      setError(cause instanceof Error && cause.message.startsWith('Allow location') ? cause.message : 'Couldn’t get your location. Check GPS and try again.');
    } finally { setLocating(false); }
  };

  const confirm = async () => {
    if (!point) { setError('When you are at this address, tap Use current location first.'); return; }
    setError('');
    try {
      const result = await confirmAddressLocation(id, point);
      const warnings = [
        result.temporarilyUnavailable ? 'Delivery isn’t available here.' : '',
        result.needsConfirmation ? 'Location saved, but it does not appear to match the written address. Please check both carefully before ordering.' : '',
        result.degraded ? 'Location saved. Map verification is not available yet, so please check your written address before ordering.' : '',
      ].filter(Boolean).join(' ');
      if (warnings) setNotice(warnings);
      // Account-scoped selection result consumed via store; navigate back once.
      setTimeout(() => router.back(), warnings ? 1200 : 0);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.includes('outside') ? 'We do not deliver to this location yet. Choose another address or contact support.' : 'Couldn’t confirm this location.');
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Confirm location" sub={addr.line1} onBack={() => router.back()} />
        <Card>
          <AppText style={shared.label}>{addr.line1}</AppText>
          <AppText style={shared.body}>When you are at this address, tap Use current location. This lets us check if we can deliver there.</AppText>
          <AppText style={shared.muted}>We use Ola Maps to check the address against your location.</AppText>
        </Card>
        <Card>
          <Button label="Use current location" icon="locate-outline" variant="soft" loading={locating} onPress={() => void locate()} />
          {!!device && <AppText style={shared.muted}>Selected: {device}</AppText>}
          {!!error && <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>}
          <Button label="Confirm location" fullWidth disabled={!point || busy || locating} loading={busy} onPress={() => void confirm()} />
          <Button label="Not now" variant="soft" fullWidth onPress={() => router.back()} />
        </Card>
        {!!notice && <Card><AppText style={shared.body}>{notice}</AppText></Card>}
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ error: { color: colors.danger } });
