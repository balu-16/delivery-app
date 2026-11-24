import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, ErrorBanner, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';

export default function AddressesPage() {
  const insets = useSafeAreaInsets();
  const addresses = useCustomer(s => s.addresses);
  const selectedAddress = useCustomer(s => s.selectedAddress);
  const locationRequired = useCustomer(s => s.locationRequired);
  const chooseAddress = useCustomer(s => s.chooseAddress);
  const refreshAddresses = useCustomer(s => s.refreshAddresses);
  const loading = useCustomer(s => s.addressBusy);

  useFocusEffect(useCallback(() => { void refreshAddresses().catch(() => undefined); }, [refreshAddresses]));
  const { refreshing, onRefresh } = useRefresh(() => refreshAddresses());

  const onSelect = async (id: string) => {
    const addr = addresses.find(a => a.id === id);
    if (!addr) return;
    if (locationRequired && !addr.point) {
      router.push({ pathname: '/addresses/[addressId]/location', params: { addressId: id } });
      return;
    }
    try { await chooseAddress(id); router.back(); } catch { /* error shown via banner */ }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title="Addresses" sub="Choose or manage your delivery addresses" onBack={() => router.canGoBack() ? router.back() : router.replace('/profile')} />
        <ErrorBanner />
        {loading && addresses.length === 0 ? <CardListSkeleton count={2} label="Loading addresses" /> : addresses.length === 0 ? (
          <Card><AppText style={shared.body}>No saved addresses yet.</AppText><AppText style={shared.muted}>Add an address to start ordering.</AppText><Button label="Add address" variant="soft" size="sm" onPress={() => router.push('/addresses/new')} /></Card>
        ) : (
          addresses.map(addr => (
            <Pressable key={addr.id} onPress={() => void onSelect(addr.id)} accessibilityRole="button" accessibilityLabel={`Select address ${addr.line1}`}>
              <Card>
                <AppText style={shared.label}>{addr.line1} {selectedAddress === addr.id ? '✓' : ''}</AppText>
                <AppText style={shared.muted}>{[addr.line2, addr.pincode].filter(Boolean).join(', ')}</AppText>
                {locationRequired && !addr.point && <AppText style={styles.warn}>Location needed · Tap to confirm</AppText>}
                <View style={shared.row}>
                  <Button label="Edit" variant="ghost" size="sm" onPress={() => router.push({ pathname: '/addresses/[addressId]/edit', params: { addressId: addr.id } })} />
                  {locationRequired && !addr.point ? <Button label="Confirm location" variant="soft" size="sm" onPress={() => router.push({ pathname: '/addresses/[addressId]/location', params: { addressId: addr.id } })} /> : <AppText style={shared.muted}>{addr.isDefault ? 'Default' : ''}</AppText>}
                </View>
              </Card>
            </Pressable>
          ))
        )}
        <Button label="Add address" variant="soft" fullWidth icon="add" onPress={() => router.push('/addresses/new')} />
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ warn: { color: colors.danger, fontSize: 12 } });
