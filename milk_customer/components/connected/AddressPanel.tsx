import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import { useRefresh } from '@/hooks/useRefresh';
import { ApiError } from '@/src/api/client';
import { requestMessage } from '@/src/api/messages';
import { customerPlacesApi, type PlaceSuggestion } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { addressErrors, type AddressErrors, type AddressField } from '@/src/utils/address-validation';
import { indianPhoneE164, indianPhoneInput } from '@/src/utils/indian-phone';
import { Card, shared } from './Shared';
import { ORDER_CONFIRMATION_WAIT } from '@/src/store/checkout-recovery';

export function AddressPanel({ visible, onClose, seed, onAddressSaved, onLocationConfirmed }: { visible: boolean; onClose: () => void; onAddressSaved?: (addressId: string) => void; onLocationConfirmed?: (addressId: string) => void; seed?: { addressId?: string; line1?: string; line2?: string; pincode?: string; phone?: string; contact?: string; focus?: 'line1' | 'pincode' | 'phone' } }) {
  const addresses = useCustomer(state => state.addresses);
  const selectedAddress = useCustomer(state => state.selectedAddress);
  const locationRequired = useCustomer(state => state.locationRequired);
  const profile = useCustomer(state => state.profile);
  const chooseAddress = useCustomer(state => state.chooseAddress);
  const addAddress = useCustomer(state => state.addAddress);
  const confirmAddressLocation = useCustomer(state => state.confirmAddressLocation);
  const refreshAddresses = useCustomer(state => state.refreshAddresses);
  const refreshDeliverySettings = useCustomer(state => state.refreshDeliverySettings);
  const checkoutPhase = useCustomer(state => state.checkoutPhase);
  const addressBusy = useCustomer(state => state.addressBusy);
  const busy = addressBusy || checkoutPhase === 'placing' || checkoutPhase === 'checking' || checkoutPhase === 'uncertain';
  const locationRequiredRef = useRef(locationRequired);
  useEffect(() => { locationRequiredRef.current = locationRequired; }, [locationRequired]);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [line1, setLine1] = useState(''), [line2, setLine2] = useState(''), [pincode, setPincode] = useState(''), [contact, setContact] = useState(''), [phone, setPhone] = useState('');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null), [deviceLocation, setDeviceLocation] = useState('');
  const [selectedPlace, setSelectedPlace] = useState('');
  const [errors, setErrors] = useState<AddressErrors>({}), [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState(''), [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [searchError, setSearchError] = useState(''), [hasSearched, setHasSearched] = useState(false);
  const [detailsPending, setDetailsPending] = useState(false), [detailsError, setDetailsError] = useState('');
  const [selectedPincode, setSelectedPincode] = useState<string | null>(null);
  const userIdRef = useRef(profile?.userId);
  const visibleRef = useRef(visible);
  const addingRef = useRef(adding);
  const queryRef = useRef(searchQuery);
  const searchSeqRef = useRef(0);
  const selectionSeqRef = useRef(0);
  const locationSeqRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const autocompleteCtlRef = useRef<AbortController | null>(null);
  const detailsCtlRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (userIdRef.current === profile?.userId) return;
    userIdRef.current = profile?.userId;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    autocompleteCtlRef.current?.abort(); detailsCtlRef.current?.abort();
    searchSeqRef.current += 1; selectionSeqRef.current += 1; locationSeqRef.current += 1;
    selectedIdRef.current = null;
    setAdding(false); setConfirming(null); setSearchQuery(''); setSuggestions([]); setSearchState('idle');
    setHasSearched(false); setDetailsError(''); setDetailsPending(false); setSearchError('');
    setLine1(''); setLine2(''); setPincode(''); setContact(''); setPhone('');
    setSelectedPincode(null); setSelectedPlace(''); setPoint(null); setDeviceLocation(''); setLocating(false);
    setErrors({}); setError(''); setNotice('');
  }, [profile?.userId]);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { addingRef.current = adding; }, [adding]);
  useEffect(() => { queryRef.current = searchQuery; }, [searchQuery]);
  useEffect(() => {
    locationSeqRef.current += 1;
    setPoint(null); setDeviceLocation(''); setLocating(false);
  }, [visible, adding, confirming]);
  useEffect(() => {
    if (visible && adding) return;
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    autocompleteCtlRef.current?.abort(); autocompleteCtlRef.current = null;
    detailsCtlRef.current?.abort(); detailsCtlRef.current = null;
    searchSeqRef.current += 1; selectionSeqRef.current += 1; selectedIdRef.current = null;
    setSuggestions([]); setSearchState('idle'); setDetailsPending(false);
  }, [visible, adding]);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    autocompleteCtlRef.current?.abort(); detailsCtlRef.current?.abort();
    locationSeqRef.current += 1;
  }, []);
  const isAbort = (cause: unknown) => cause instanceof Error && cause.name === 'AbortError';
  const runSearch = async (rawQuery: string) => {
    const query = rawQuery.trim();
    if (query.length < 3) { setSuggestions([]); setSearchState('idle'); setSearchError(''); return; }
    const seq = ++searchSeqRef.current;
    const userId = userIdRef.current;
    autocompleteCtlRef.current?.abort();
    const ctl = new AbortController();
    autocompleteCtlRef.current = ctl;
    setSearchState('loading'); setSearchError('');
    try {
      const token = await accessToken();
      if (ctl.signal.aborted || useCustomer.getState().profile?.userId !== userId) return;
      const result = await customerPlacesApi.autocomplete(token, query, ctl.signal);
      if (ctl.signal.aborted || seq !== searchSeqRef.current || queryRef.current.trim() !== query) return;
      if (!visibleRef.current || !addingRef.current || useCustomer.getState().profile?.userId !== userId) return;
      const list = (result ?? []).slice(0, 5);
      setSuggestions(list); setHasSearched(true);
      setSearchState(list.length === 0 ? 'empty' : 'ready');
    } catch (cause) {
      if (ctl.signal.aborted || isAbort(cause) || seq !== searchSeqRef.current) return;
      if (!visibleRef.current || !addingRef.current || useCustomer.getState().profile?.userId !== userId) return;
      setSuggestions([]); setHasSearched(true); setSearchState('error');
      setSearchError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403) ? 'Sign in again to continue.' : 'Address search unavailable. Enter it manually.');
    }
  };
  const onSearchChange = (value: string) => {
    queryRef.current = value;
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    autocompleteCtlRef.current?.abort(); autocompleteCtlRef.current = null;
    searchSeqRef.current += 1;
    detailsCtlRef.current?.abort(); detailsCtlRef.current = null;
    selectionSeqRef.current += 1; selectedIdRef.current = null;
    setDetailsPending(false); setDetailsError(''); setSelectedPlace(''); setSelectedPincode(null);
    setSuggestions([]); setSearchState('idle'); setSearchError('');
    if (value.trim().length < 3) { setSuggestions([]); setSearchState('idle'); setSearchError(''); return; }
    debounceRef.current = setTimeout(() => void runSearch(value), 300);
  };
  const selectSuggestion = (suggestion: PlaceSuggestion) => {
    const seq = ++selectionSeqRef.current;
    const userId = userIdRef.current;
    const id = suggestion.id;
    selectedIdRef.current = id;
    detailsCtlRef.current?.abort();
    const ctl = new AbortController();
    detailsCtlRef.current = ctl;
    setDetailsPending(true); setDetailsError('');
    void (async () => {
      try {
        const token = await accessToken();
        if (ctl.signal.aborted || useCustomer.getState().profile?.userId !== userId) return;
        const details = await customerPlacesApi.details(token, id, ctl.signal);
        if (ctl.signal.aborted || seq !== selectionSeqRef.current || selectedIdRef.current !== id) return;
        if (!visibleRef.current || !addingRef.current || useCustomer.getState().profile?.userId !== userId) return;
        const location = details?.location;
        if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) { setDetailsError('That place is unavailable. Choose another result.'); return; }
        const description = details.description || suggestion.description;
        setSelectedPlace(description);
        const pin = typeof details.pincode === 'string' && /^\d{6}$/.test(details.pincode) ? details.pincode : null;
        setSelectedPincode(pin);
        setLine2(previous => previous.trim() === '' && description.length > 0 && description.length <= 200 ? description : previous);
        if (pin) setPincode(previous => previous.trim() === '' ? pin : previous);
      } catch (cause) {
        if (ctl.signal.aborted || isAbort(cause) || seq !== selectionSeqRef.current || selectedIdRef.current !== id) return;
        if (!visibleRef.current || !addingRef.current || useCustomer.getState().profile?.userId !== userId) return;
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setDetailsError('Sign in again to continue.');
        else if (cause instanceof ApiError && (cause.status === 404 || cause.code === 'PLACE_NOT_FOUND')) setDetailsError('That place is unavailable. Choose another result.');
        else setDetailsError('Address search unavailable. Enter it manually.');
      } finally {
        if (seq === selectionSeqRef.current && visibleRef.current && addingRef.current && useCustomer.getState().profile?.userId === userId) setDetailsPending(false);
      }
    })();
  };
  useEffect(() => {
    if (!visible) return;
    void refreshAddresses().catch(() => setError('Couldn’t refresh saved addresses.'));
    void refreshDeliverySettings().catch(() => setError('Couldn’t check delivery settings.'));
    setConfirming(locationRequiredRef.current ? seed?.addressId ?? null : null);
    if (seed?.line1) setLine1(seed.line1);
    if (seed?.line2) setLine2(seed.line2);
    if (seed?.pincode) setPincode(seed.pincode);
    if (seed?.phone) setPhone(seed.phone);
    if (seed?.contact) setContact(seed.contact);
    if (seed?.line1 || seed?.pincode || seed?.focus) setAdding(true);
    if (seed?.focus === 'phone') setErrors({ phone: 'Enter the 10-digit mobile number. +91 is added for you.' });
    if (seed?.focus === 'pincode') setErrors({ pincode: 'Enter the 6-digit pincode.' });
    if (seed?.focus === 'line1') setErrors({ line1: 'Enter the street address.' });
  }, [visible, seed, refreshAddresses, refreshDeliverySettings]);
  const clearField = (field: AddressField) => setErrors(previous => ({ ...previous, [field]: undefined }));
  const fieldError = (field: AddressField) => errors[field] ? <AppText accessibilityLiveRegion="polite" style={styles.error}>{errors[field]}</AppText> : null;
  const savedRefresh = useRefresh(async () => {
    const userId = profile?.userId;
    try { await refreshAddresses(); }
    catch { if (visibleRef.current && useCustomer.getState().profile?.userId === userId) setError('Couldn’t refresh saved addresses.'); }
  });
  const locate = async () => {
    const seq = ++locationSeqRef.current;
    const userId = profile?.userId;
    const current = () => seq === locationSeqRef.current && visibleRef.current && useCustomer.getState().profile?.userId === userId;
    setError(''); clearField('location'); setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!current()) return;
      if (permission.status !== 'granted') throw new Error('Allow location access in your phone settings, then try again.');
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (!current()) return;
      setPoint({ lat: location.coords.latitude, lng: location.coords.longitude });
      setDeviceLocation(`Current location${location.coords.accuracy ? ` (about ${Math.round(location.coords.accuracy)} m accuracy)` : ''}`);
    } catch (cause) {
      if (!current()) return;
      setPoint(null); setDeviceLocation('');
      setErrors(previous => ({ ...previous, location: cause instanceof Error && cause.message.startsWith('Allow location') ? cause.message : 'Couldn’t get your location. Check GPS and try again.' }));
    } finally { if (current()) setLocating(false); }
  };
  const save = async () => {
    const nextErrors = addressErrors({ line1, line2, pincode, contact, phone, point });
    setErrors(nextErrors); setError('');
    const contactPhone = indianPhoneE164(phone);
    if (Object.keys(nextErrors).length || !contactPhone) return;
    try {
      const result = await addAddress({ line1: line1.trim(), ...(line2.trim() ? { line2: line2.trim() } : {}), pincode, contactName: contact.trim(), contactPhone, ...(point ?? {}) });
      onAddressSaved?.(result.id);
      setAdding(false); setLine1(''); setLine2(''); setPincode(''); setContact(''); setPhone(''); setPoint(null); setSelectedPlace('');
      setSearchQuery(''); setSuggestions([]); setSearchState('idle'); setSearchError(''); setHasSearched(false); setDetailsError(''); setDetailsPending(false); setSelectedPincode(null);
      if (result.locationNeeded) { setNotice('Address saved. When you are at this address, confirm your location to check delivery and order.'); setConfirming(result.id); return; }
      onLocationConfirmed?.(result.id);
      const warnings = [result.needsConfirmation ? 'The entered address differs from the selected location. Check the pin and address carefully.' : result.degraded ? 'The address could not be independently verified. Check your selected location carefully.' : '', result.temporarilyUnavailable ? 'Delivery is temporarily unavailable at this address.' : ''].filter(Boolean);
      if (warnings.length) setNotice(`Address saved. ${warnings.join(' ')}`); else onClose();
    } catch (cause) {
      if (cause instanceof Error && cause.message === ORDER_CONFIRMATION_WAIT) setError(ORDER_CONFIRMATION_WAIT);
      else if (cause instanceof ApiError && cause.code === 'INVALID_PINCODE') setErrors(previous => ({ ...previous, pincode: 'Enter a six-digit PIN code.' }));
      else if (cause instanceof ApiError && cause.code === 'INVALID_CONTACT_PHONE') setErrors(previous => ({ ...previous, phone: 'Enter a valid 10-digit Indian phone number.' }));
      else if (cause instanceof ApiError && cause.code === 'INVALID_COORDINATES') setErrors(previous => ({ ...previous, location: 'Select your current location again.' }));
      else if (cause instanceof ApiError && cause.code === 'ADDRESS_LIMIT_REACHED') setError('You have reached the saved address limit. Contact support to update an address.');
      else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setError(requestMessage(cause, 'save this address'));
      else if (cause instanceof ApiError && cause.code === 'INVALID_ADDRESS') setError('Check your house and street and contact name.');
      else if (cause instanceof Error && cause.message.includes('outside')) setErrors(previous => ({ ...previous, location: 'This location is outside our current delivery area.' }));
      else if (cause instanceof Error && cause.message.startsWith('Couldn’t check delivery coverage.')) setError(cause.message);
      else setError(`${requestMessage(cause, 'save this address')} Check your saved addresses before retrying.`);
    }
  };
  const confirmLocation = async () => {
    if (!confirming || !point) { setError('When you are at this address, tap Use current location first.'); return; }
    setError('');
    try {
      const result = await confirmAddressLocation(confirming, point);
      const id = confirming;
      setConfirming(null); setPoint(null); setSelectedPlace(''); setNotice('');
      if (result.temporarilyUnavailable) setNotice('Delivery isn’t available here.');
      else if (result.needsConfirmation) {onLocationConfirmed?.(id);setNotice('Location saved, but it does not appear to match the written address. Please check both carefully before ordering.');}
      else if (result.degraded) {onLocationConfirmed?.(id);setNotice('Location saved. Map verification is not available yet, so please check your written address before ordering.');}
      else { onLocationConfirmed?.(id); onClose(); }
    } catch (cause) {
      if (cause instanceof Error && cause.message === ORDER_CONFIRMATION_WAIT) setError(ORDER_CONFIRMATION_WAIT);
      else setError(cause instanceof Error && cause.message.includes('outside') ? 'We do not deliver to this location yet. Choose another address or contact support.' : 'Couldn’t confirm this location.');
    }
  };
  return <BottomSheet visible={visible} onClose={onClose} title="Delivery address" subtitle="Choose a saved address or add a new one." keyboardAware={adding} refreshControl={adding ? undefined : <RefreshControl refreshing={savedRefresh.refreshing} onRefresh={() => void savedRefresh.onRefresh()} tintColor={colors.green} />}>
    {confirming && !adding ? <View style={{gap:10}}>
      {!!notice && <AppText accessibilityLiveRegion="polite" style={shared.body}>{notice}</AppText>}
      <AppText style={shared.label}>{addresses.find(item => item.id === confirming)?.line1 ?? 'Saved address'}</AppText>
      <AppText style={shared.body}>When you are at this address, tap Use current location. This lets us check if we can deliver there.</AppText>
      <AppText style={shared.muted}>We use Ola Maps to check the address against your location.</AppText>
      <Button label="Use current location" icon="locate-outline" variant="soft" loading={locating} onPress={() => void locate()} />
      {!!deviceLocation && <AppText style={shared.muted}>Selected: {deviceLocation}</AppText>}
      {fieldError('location')}
      {!!error && <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>}
      <Button label="Confirm location" fullWidth disabled={!point || busy || locating} loading={busy} onPress={() => void confirmLocation()} />
      <Button label="Not now" variant="soft" fullWidth onPress={() => {setConfirming(null);setPoint(null);setNotice('');setError('');onClose();}} />
    </View> : adding ? <View style={{ gap: 9 }}>
      <TextInput style={[shared.input]} placeholder="Search a place or landmark" value={searchQuery} onChangeText={onSearchChange} maxLength={200} accessibilityLabel="Search a place or landmark" />
      {!hasSearched && <View style={{ gap: 4 }}>
        <AppText style={shared.muted}>Location search by Ola Maps. Your search and the place you choose are shared with Ola Maps to show results.</AppText>
        <Pressable onPress={() => void Linking.openURL('https://maps.olakrutrim.com/legal/platform-privacy-policy').catch(() => undefined)} accessibilityRole="link" accessibilityLabel="Ola privacy notice"><AppText style={shared.muted}>Ola privacy notice</AppText></Pressable>
      </View>}
      {searchState === 'loading' && <View style={styles.searchStatus}><ActivityIndicator size="small" color={colors.green} /><AppText accessibilityLiveRegion="polite" style={shared.muted}>Searching…</AppText></View>}
      {searchState === 'empty' && <AppText style={shared.muted}>No places found. Try a nearby landmark.</AppText>}
      {searchState === 'error' && <View style={{ gap: 4 }}>
        <AppText style={shared.body}>{searchError}</AppText>
        <Button label="Retry" size="sm" variant="soft" onPress={() => void runSearch(searchQuery)} />
      </View>}
      {suggestions.map(suggestion => <Pressable key={suggestion.id} onPress={() => selectSuggestion(suggestion)} accessibilityRole="button" accessibilityLabel={`Select ${suggestion.description}`}><AppText style={shared.body}>{suggestion.description}</AppText></Pressable>)}
      {detailsPending && <View style={styles.searchStatus}><ActivityIndicator size="small" color={colors.green} /><AppText accessibilityLiveRegion="polite" style={shared.muted}>Loading place…</AppText></View>}
      {!!detailsError && <AppText style={shared.body}>{detailsError}</AppText>}
      <Button size="sm" label="Use current location" icon="locate-outline" variant="soft" loading={locating} onPress={() => void locate()} />
      <AppText style={shared.muted}>{locationRequired ? 'You can save the address now and confirm its location later. To order, confirm your location while you are at the delivery address.' : 'We check delivery using your PIN code. You can also share your location for your delivery partner.'}</AppText>
      {!!selectedPlace && <AppText style={shared.muted}>Selected: {selectedPlace}</AppText>}
      {!!deviceLocation && <AppText style={shared.muted}>{deviceLocation}</AppText>}
      {fieldError('location')}
      <TextInput style={[shared.input, errors.line1 && styles.invalid]} placeholder="House and street" value={line1} onChangeText={value => { setLine1(value); clearField('line1'); }} maxLength={200} accessibilityLabel="House and street" />
      {fieldError('line1')}
      <TextInput style={[shared.input, errors.line2 && styles.invalid]} placeholder="Area and landmark (optional)" value={line2} onChangeText={value => { setLine2(value); clearField('line2'); }} maxLength={200} accessibilityLabel="Area and landmark" />
      {fieldError('line2')}
      <TextInput style={[shared.input, errors.pincode && styles.invalid]} placeholder="PIN code" value={pincode} onChangeText={value => { setPincode(value); clearField('pincode'); }} keyboardType="number-pad" maxLength={6} accessibilityLabel="PIN code" />
      {fieldError('pincode')}
      {!!selectedPincode && pincode.trim() !== '' && pincode.trim() !== selectedPincode && <AppText style={shared.body}>Check the PIN code for this address.</AppText>}
      <TextInput style={[shared.input, errors.contact && styles.invalid]} placeholder="Contact name" value={contact} onChangeText={value => { setContact(value); clearField('contact'); }} maxLength={120} accessibilityLabel="Contact name" />
      {fieldError('contact')}
      <View style={[shared.input, styles.phoneRow, errors.phone && styles.invalid]}><AppText style={styles.prefix}>+91</AppText><TextInput style={styles.phoneInput} placeholder="10-digit phone number" value={phone} onChangeText={value => { setPhone(indianPhoneInput(value)); clearField('phone'); }} keyboardType="phone-pad" autoComplete="tel-national" accessibilityLabel="Contact phone" /></View>
      {fieldError('phone')}
      {!!error && <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>}
      <Button label="Save address" fullWidth onPress={() => void save()} disabled={busy || locating} loading={busy} />
      <Button label="Cancel" fullWidth variant="soft" onPress={() => { setAdding(false); setErrors({}); setError(''); }} />
    </View> : <View style={{ gap: 10 }}>
      {!!notice && <Card><AppText style={shared.body}>{notice}</AppText><Button label="Got it" size="sm" variant="soft" onPress={() => { setNotice(''); onClose(); }} /></Card>}
      {!!error && <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>}
      {addresses.length === 0 ? <AppText style={shared.muted}>Add an address to see products available near you.</AppText> : addresses.map(address => <Pressable key={address.id} onPress={() => {if (locationRequired && !address.point) {setConfirming(address.id);onAddressSaved?.(address.id);setError('');setNotice('');} else void chooseAddress(address.id).then(() => {onLocationConfirmed?.(address.id);onClose();}).catch(() => setError(busy ? ORDER_CONFIRMATION_WAIT : 'Couldn’t select this address.'));}}><Card><AppText style={shared.label}>{address.line1} {selectedAddress === address.id ? '✓' : ''}</AppText><AppText style={shared.muted}>{[address.line2, address.pincode].filter(Boolean).join(', ')}</AppText>{locationRequired && !address.point && <AppText style={styles.error}>Location needed · Tap to confirm</AppText>}</Card></Pressable>)}
      <Button label="Add address" variant="soft" fullWidth icon="add" onPress={() => setAdding(true)} />
    </View>}
  </BottomSheet>;
}
const styles = StyleSheet.create({
  error: { color: colors.danger },
  searchStatus: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  invalid: { borderColor: colors.danger },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  prefix: { color: colors.text, borderRightWidth: 1, borderRightColor: colors.lineStrong, paddingRight: 10 },
  phoneInput: { flex: 1, minHeight: 46, color: colors.text, paddingVertical: 0 },
});
