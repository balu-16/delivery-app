import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { AddressForm } from '@/components/connected/AddressForm';
import { Card, shared } from '@/components/connected/Shared';
import { colors } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { UUID_RE } from '@/src/utils/order-groups';

export default function NewAddressPage() {
  const insets = useSafeAreaInsets();
  const addAddress = useCustomer(s => s.addAddress);
  const saving = useCustomer(s => s.addressBusy);
  const [notice, setNotice] = useState('');

  const onSave = async (value: { line1: string; line2?: string; pincode: string; contactName: string; contactPhone: string; lat?: number; lng?: number }) => {
    const result = await addAddress({ line1: value.line1, ...(value.line2 ? { line2: value.line2 } : {}), pincode: value.pincode, contactName: value.contactName, contactPhone: value.contactPhone, ...(value.lat !== undefined && value.lng !== undefined ? { lat: value.lat, lng: value.lng } : {}) } as never);
    const warnings = [
      result.locationNeeded ? 'Address saved. When you are at this address, confirm your location to check delivery and order.' : '',
      result.needsConfirmation ? 'The entered address differs from the selected location. Check the pin and address carefully.' : result.degraded ? 'The address could not be independently verified. Check your selected location carefully.' : '',
      result.temporarilyUnavailable ? 'Delivery is temporarily unavailable at this address.' : '',
    ].filter(Boolean).join(' ');
    if (warnings) {
      // Caller consumes result via account state; still navigate back once per §3 contract.
      setNotice(warnings);
      // Navigate back after showing notice via parent; for simplicity show inline then back.
      setTimeout(() => router.back(), 1200);
    } else {
      router.back();
    }
  };

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Add address" sub="Delivery address" onBack={() => router.canGoBack() ? router.back() : router.push('/addresses')} />
        {!!notice && <Card><AppText style={shared.body}>{notice}</AppText><Button label="Got it" size="sm" variant="soft" onPress={() => router.back()} /></Card>}
        <AddressForm onSave={onSave} saving={saving} saveLabel="Save address" />
        <AppText style={[shared.muted, styles.foot]}>Saved addresses are scoped to your account. Drafts stay on this phone until saved.</AppText>
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ foot: { marginTop: 8 } });
