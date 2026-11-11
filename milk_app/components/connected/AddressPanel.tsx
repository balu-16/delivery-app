import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { Card, shared } from './Shared';

export function AddressPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { addresses, selectedAddress, chooseAddress, addAddress, busy } = useCustomer();
  const [adding, setAdding] = useState(false);
  const [line1, setLine1] = useState(''), [line2, setLine2] = useState(''), [pincode, setPincode] = useState(''), [contact, setContact] = useState(''), [phone, setPhone] = useState('');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null), [selectedPlace, setSelectedPlace] = useState(''), [error, setError] = useState('');
  const [locating, setLocating] = useState(false), [showMapInfo, setShowMapInfo] = useState(false);
  const [notice, setNotice] = useState('');
  const locate = async () => {
    setError(''); setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') throw new Error('Location permission was not granted.');
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setPoint({lat: location.coords.latitude, lng: location.coords.longitude});
      setSelectedPlace(`Current location${location.coords.accuracy ? ` (about ${Math.round(location.coords.accuracy)} m accuracy)` : ''}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not get your location. Please try again.'); }
    finally { setLocating(false); }
  };
  const save = async () => {
    if (!line1.trim() || !/^\d{6}$/.test(pincode) || !contact.trim() || !/^\+[1-9]\d{7,14}$/.test(phone) || !point) { setError('Enter the address, six-digit PIN, contact name and phone with country code, and use your current location.'); return; }
    try { const result = await addAddress({ line1: line1.trim(), ...(line2.trim() ? { line2: line2.trim() } : {}), pincode, contactName: contact.trim(), contactPhone: phone, ...point }); setAdding(false); setLine1(''); setLine2(''); setPincode(''); setContact(''); setPhone(''); setPoint(null); setSelectedPlace('');
      const warnings = [result.needsConfirmation ? 'The entered address differs from the selected location. Check the pin and address carefully.' : result.degraded ? 'The address could not be independently verified. Check your selected location carefully.' : '', result.temporarilyUnavailable ? 'Delivery is temporarily unavailable at this address.' : ''].filter(Boolean);
      if (warnings.length) setNotice(`Address saved. ${warnings.join(' ')}`); else onClose();
    } catch (cause) { setError(cause instanceof Error && cause.message.includes('outside') ? cause.message : 'Could not confirm whether the address was saved. Check your saved addresses before retrying.'); }
  };
  return <BottomSheet visible={visible} onClose={onClose} title="Delivery address" subtitle="Choose a saved address or add a new one.">
    {adding ? <View style={{ gap: 9 }}>
      <Button size="sm" label="Search on map" icon="map-outline" variant="soft" onPress={() => setShowMapInfo(true)} />
      {showMapInfo && <AppText style={shared.muted}>We’re currently working on maps. For now, use your current location at the delivery address.</AppText>}
      <Button size="sm" label="Use current location" icon="locate-outline" variant="soft" loading={locating} onPress={() => void locate()} />
      <AppText style={shared.muted}>Location is used only to set this delivery address. Check that you are at the delivery location.</AppText>
      {!!selectedPlace && <AppText style={shared.muted}>Selected: {selectedPlace}</AppText>}
      <TextInput style={shared.input} placeholder="House and street" value={line1} onChangeText={setLine1} accessibilityLabel="House and street" />
      <TextInput style={shared.input} placeholder="Area and landmark (optional)" value={line2} onChangeText={setLine2} accessibilityLabel="Area and landmark" />
      <TextInput style={shared.input} placeholder="PIN code" value={pincode} onChangeText={setPincode} keyboardType="number-pad" maxLength={6} accessibilityLabel="PIN code" />
      <TextInput style={shared.input} placeholder="Contact name" value={contact} onChangeText={setContact} accessibilityLabel="Contact name" />
      <TextInput style={shared.input} placeholder="Phone, e.g. +91..." value={phone} onChangeText={setPhone} keyboardType="phone-pad" accessibilityLabel="Contact phone" />
      {!!error && <AppText style={{ color: colors.danger }}>{error}</AppText>}
      <Button label="Save address" fullWidth onPress={() => void save()} disabled={busy} loading={busy} />
      <Button label="Cancel" fullWidth variant="soft" onPress={() => { setAdding(false); setError(''); }} />
    </View> : <View style={{ gap: 10 }}>
      {!!notice && <Card><AppText style={shared.body}>{notice}</AppText><Button label="Got it" size="sm" variant="soft" onPress={() => {setNotice('');onClose();}} /></Card>}
      {addresses.length === 0 ? <AppText style={shared.muted}>Add an address to see products available near you.</AppText> : addresses.map(address => <Pressable key={address.id} onPress={() => void chooseAddress(address.id).then(onClose)}><Card><AppText style={shared.label}>{address.line1} {selectedAddress === address.id ? '✓' : ''}</AppText><AppText style={shared.muted}>{[address.line2, address.pincode].filter(Boolean).join(', ')}</AppText></Card></Pressable>)}
      <Button label="Add address" variant="soft" fullWidth icon="add" onPress={() => setAdding(true)} />
    </View>}
  </BottomSheet>;
}
