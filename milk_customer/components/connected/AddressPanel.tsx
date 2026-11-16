import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import { ApiError } from '@/src/api/client';
import { useCustomer } from '@/src/store/customer';
import { addressErrors, type AddressErrors, type AddressField } from '@/src/utils/address-validation';
import { indianPhoneE164, indianPhoneInput } from '@/src/utils/indian-phone';
import { Card, shared } from './Shared';

export function AddressPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { addresses, selectedAddress, chooseAddress, addAddress, busy } = useCustomer();
  const [adding, setAdding] = useState(false);
  const [line1, setLine1] = useState(''), [line2, setLine2] = useState(''), [pincode, setPincode] = useState(''), [contact, setContact] = useState(''), [phone, setPhone] = useState('');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null), [selectedPlace, setSelectedPlace] = useState('');
  const [errors, setErrors] = useState<AddressErrors>({}), [error, setError] = useState('');
  const [locating, setLocating] = useState(false), [showMapInfo, setShowMapInfo] = useState(false);
  const [notice, setNotice] = useState('');
  const clearField = (field: AddressField) => setErrors(previous => ({ ...previous, [field]: undefined }));
  const fieldError = (field: AddressField) => errors[field] ? <AppText accessibilityLiveRegion="polite" style={styles.error}>{errors[field]}</AppText> : null;
  const locate = async () => {
    setError(''); clearField('location'); setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') throw new Error('Allow location access in your phone settings, then try again.');
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setPoint({ lat: location.coords.latitude, lng: location.coords.longitude });
      setSelectedPlace(`Current location${location.coords.accuracy ? ` (about ${Math.round(location.coords.accuracy)} m accuracy)` : ''}`);
    } catch (cause) {
      setPoint(null); setSelectedPlace('');
      setErrors(previous => ({ ...previous, location: cause instanceof Error && cause.message.startsWith('Allow location') ? cause.message : 'Could not get your location. Check GPS and try again.' }));
    } finally { setLocating(false); }
  };
  const save = async () => {
    const nextErrors = addressErrors({ line1, line2, pincode, contact, phone, point });
    setErrors(nextErrors); setError('');
    const contactPhone = indianPhoneE164(phone);
    if (Object.keys(nextErrors).length || !point || !contactPhone) return;
    try {
      const result = await addAddress({ line1: line1.trim(), ...(line2.trim() ? { line2: line2.trim() } : {}), pincode, contactName: contact.trim(), contactPhone, ...point });
      setAdding(false); setLine1(''); setLine2(''); setPincode(''); setContact(''); setPhone(''); setPoint(null); setSelectedPlace('');
      const warnings = [result.needsConfirmation ? 'The entered address differs from the selected location. Check the pin and address carefully.' : result.degraded ? 'The address could not be independently verified. Check your selected location carefully.' : '', result.temporarilyUnavailable ? 'Delivery is temporarily unavailable at this address.' : ''].filter(Boolean);
      if (warnings.length) setNotice(`Address saved. ${warnings.join(' ')}`); else onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'INVALID_PINCODE') setErrors(previous => ({ ...previous, pincode: 'Enter a six-digit PIN code.' }));
      else if (cause instanceof ApiError && cause.code === 'INVALID_CONTACT_PHONE') setErrors(previous => ({ ...previous, phone: 'Enter a valid 10-digit Indian phone number.' }));
      else if (cause instanceof ApiError && cause.code === 'INVALID_COORDINATES') setErrors(previous => ({ ...previous, location: 'Select your current location again.' }));
      else if (cause instanceof ApiError && cause.code === 'ADDRESS_LIMIT_REACHED') setError('You have reached the saved address limit. Contact support to update an address.');
      else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setError('Your session has expired. Sign in again to save an address.');
      else if (cause instanceof ApiError && cause.code === 'INVALID_ADDRESS') setError('Check your house and street and contact name.');
      else if (cause instanceof Error && cause.message.includes('outside')) setErrors(previous => ({ ...previous, location: 'This location is outside our current delivery area.' }));
      else if (cause instanceof Error && cause.message.startsWith('Could not check delivery coverage.')) setError(cause.message);
      else setError('Could not confirm whether the address was saved. Check your saved addresses before retrying.');
    }
  };
  return <BottomSheet visible={visible} onClose={onClose} title="Delivery address" subtitle="Choose a saved address or add a new one." keyboardAware={adding}>
    {adding ? <View style={{ gap: 9 }}>
      <Button size="sm" label="Search on map" icon="map-outline" variant="soft" onPress={() => setShowMapInfo(true)} />
      {showMapInfo && <AppText style={shared.muted}>We’re currently working on maps. For now, use your current location at the delivery address.</AppText>}
      <Button size="sm" label="Use current location" icon="locate-outline" variant="soft" loading={locating} onPress={() => void locate()} />
      <AppText style={shared.muted}>Location is used only to set this delivery address. Check that you are at the delivery location.</AppText>
      {!!selectedPlace && <AppText style={shared.muted}>Selected: {selectedPlace}</AppText>}
      {fieldError('location')}
      <TextInput style={[shared.input, errors.line1 && styles.invalid]} placeholder="House and street" value={line1} onChangeText={value => { setLine1(value); clearField('line1'); }} maxLength={200} accessibilityLabel="House and street" />
      {fieldError('line1')}
      <TextInput style={[shared.input, errors.line2 && styles.invalid]} placeholder="Area and landmark (optional)" value={line2} onChangeText={value => { setLine2(value); clearField('line2'); }} maxLength={200} accessibilityLabel="Area and landmark" />
      {fieldError('line2')}
      <TextInput style={[shared.input, errors.pincode && styles.invalid]} placeholder="PIN code" value={pincode} onChangeText={value => { setPincode(value); clearField('pincode'); }} keyboardType="number-pad" maxLength={6} accessibilityLabel="PIN code" />
      {fieldError('pincode')}
      <TextInput style={[shared.input, errors.contact && styles.invalid]} placeholder="Contact name" value={contact} onChangeText={value => { setContact(value); clearField('contact'); }} maxLength={120} accessibilityLabel="Contact name" />
      {fieldError('contact')}
      <View style={[shared.input, styles.phoneRow, errors.phone && styles.invalid]}><AppText style={styles.prefix}>+91</AppText><TextInput style={styles.phoneInput} placeholder="10-digit phone number" value={phone} onChangeText={value => { setPhone(indianPhoneInput(value)); clearField('phone'); }} keyboardType="phone-pad" autoComplete="tel-national" accessibilityLabel="Contact phone" /></View>
      {fieldError('phone')}
      {!!error && <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>}
      <Button label="Save address" fullWidth onPress={() => void save()} disabled={busy || locating} loading={busy} />
      <Button label="Cancel" fullWidth variant="soft" onPress={() => { setAdding(false); setErrors({}); setError(''); }} />
    </View> : <View style={{ gap: 10 }}>
      {!!notice && <Card><AppText style={shared.body}>{notice}</AppText><Button label="Got it" size="sm" variant="soft" onPress={() => { setNotice(''); onClose(); }} /></Card>}
      {addresses.length === 0 ? <AppText style={shared.muted}>Add an address to see products available near you.</AppText> : addresses.map(address => <Pressable key={address.id} onPress={() => void chooseAddress(address.id).then(onClose)}><Card><AppText style={shared.label}>{address.line1} {selectedAddress === address.id ? '✓' : ''}</AppText><AppText style={shared.muted}>{[address.line2, address.pincode].filter(Boolean).join(', ')}</AppText></Card></Pressable>)}
      <Button label="Add address" variant="soft" fullWidth icon="add" onPress={() => setAdding(true)} />
    </View>}
  </BottomSheet>;
}
const styles = StyleSheet.create({
  error: { color: colors.danger },
  invalid: { borderColor: colors.danger },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  prefix: { color: colors.text, borderRightWidth: 1, borderRightColor: colors.lineStrong, paddingRight: 10 },
  phoneInput: { flex: 1, minHeight: 46, color: colors.text, paddingVertical: 0 },
});
