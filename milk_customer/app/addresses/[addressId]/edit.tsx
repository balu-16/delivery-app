import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { AddressForm } from '@/components/connected/AddressForm';
import { Card, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { useCustomer } from '@/src/store/customer';
import { UUID_RE } from '@/src/utils/order-groups';

export default function EditAddressPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ addressId?: string }>();
  const id = typeof params.addressId === 'string' && UUID_RE.test(params.addressId) ? params.addressId : null;
  const addresses = useCustomer(s => s.addresses);
  const editAddress = useCustomer(s => s.editAddress);
  const saving = useCustomer(s => s.addressBusy);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  if (!id) return (
    <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
      <PageHeader title="Edit address" onBack={() => router.back()} />
      <Card><AppText style={shared.body}>Address not found.</AppText><Button label="Back to Addresses" variant="soft" size="sm" onPress={() => router.replace('/addresses')} /></Card>
    </ScrollView></Screen>
  );

  const existing = addresses.find(a => a.id === id);
  if (!existing) return (
    <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
      <PageHeader title="Edit address" onBack={() => router.back()} />
      <CardListSkeleton count={1} label="Loading address" />
    </ScrollView></Screen>
  );

  const onSave = async (value: { line1: string; line2?: string; pincode: string; contactName: string; contactPhone: string; lat?: number; lng?: number }) => {
    setError('');
    try {
      const result = await editAddress(id, { line1: value.line1, ...(value.line2 !== undefined ? { line2: value.line2 } : {}), pincode: value.pincode, contactName: value.contactName, contactPhone: value.contactPhone, ...(value.lat !== undefined ? { lat: value.lat, lng: value.lng! } : {}), version: existing.version } as never);
      const warn = result.needsConfirmation ? 'The entered address differs from the saved location. Check carefully before ordering.' : result.degraded ? 'Map verification is not available yet. Check your address before ordering.' : '';
      if (warn) setNotice(warn);
      // Account state updated via store; navigate back once.
      setTimeout(() => router.back(), warn ? 1200 : 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Couldn’t save this address.';
      // Version conflict: keep draft, let customer review current address before retrying.
      if ((e as { code?: string })?.code === 'VERSION_CONFLICT' || msg.includes('conflict') || msg.includes('version')) {
        setError('This address changed on the server. Review the current address on the list and try again. Your draft is kept here.');
      } else {
        setError(msg);
        throw e;
      }
    }
  };

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Edit address" sub={existing.line1} onBack={() => router.back()} />
        {!!notice && <Card><AppText style={shared.body}>{notice}</AppText></Card>}
        {!!error && <Card><AppText style={shared.body}>{error}</AppText><Button label="Review addresses" variant="soft" size="sm" onPress={() => router.push('/addresses')} /></Card>}
        <AddressForm
          initial={{ line1: existing.line1, line2: existing.line2 ?? '', pincode: existing.pincode, contact: existing.contactName, phone: existing.contactPhone.replace(/^\+91/, '') }}
          onSave={onSave}
          saving={saving}
          saveLabel="Save changes"
        />
        <AppText style={[shared.muted, styles.foot]}>Editing keeps the same address record. Use Confirm location if the pin still needs validation.</AppText>
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ foot: { marginTop: 8 } });
