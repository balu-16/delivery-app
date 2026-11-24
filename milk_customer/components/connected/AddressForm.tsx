import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import { ApiError } from '@/src/api/client';
import { requestMessage } from '@/src/api/messages';
import { customerPlacesApi, type PlaceSuggestion } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { addressErrors, type AddressErrors, type AddressField } from '@/src/utils/address-validation';
import { indianPhoneE164, indianPhoneInput } from '@/src/utils/indian-phone';
import { shared } from './Shared';

type Props = {
  initial?: { line1?: string; line2?: string; pincode?: string; contact?: string; phone?: string };
  onSave: (value: { line1: string; line2?: string; pincode: string; contactName: string; contactPhone: string; lat?: number; lng?: number }) => Promise<void>;
  saving: boolean;
  saveLabel?: string;
  showLocationHint?: boolean;
};

export function AddressForm({ initial, onSave, saving, saveLabel = 'Save address', showLocationHint = true }: Props) {
  const locationRequired = useCustomer(s => s.locationRequired);
  const profile = useCustomer(s => s.profile);
  const [line1, setLine1] = useState(initial?.line1 ?? '');
  const [line2, setLine2] = useState(initial?.line2 ?? '');
  const [pincode, setPincode] = useState(initial?.pincode ?? '');
  const [contact, setContact] = useState(initial?.contact ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [deviceLocation, setDeviceLocation] = useState('');
  const [selectedPlace, setSelectedPlace] = useState('');
  const [errors, setErrors] = useState<AddressErrors>({});
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [searchError, setSearchError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [detailsPending, setDetailsPending] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [selectedPincode, setSelectedPincode] = useState<string | null>(null);

  const queryRef = useRef(searchQuery);
  const searchSeqRef = useRef(0);
  const selectionSeqRef = useRef(0);
  const autocompleteCtlRef = useRef<AbortController | null>(null);
  const detailsCtlRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { queryRef.current = searchQuery; }, [searchQuery]);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    autocompleteCtlRef.current?.abort(); detailsCtlRef.current?.abort();
  }, []);

  const isAbort = (c: unknown) => c instanceof Error && c.name === 'AbortError';
  const runSearch = async (raw: string) => {
    const q = raw.trim();
    if (q.length < 3) { setSuggestions([]); setSearchState('idle'); setSearchError(''); return; }
    const seq = ++searchSeqRef.current;
    autocompleteCtlRef.current?.abort();
    const ctl = new AbortController();
    autocompleteCtlRef.current = ctl;
    setSearchState('loading'); setSearchError('');
    try {
      const token = await accessToken();
      if (ctl.signal.aborted) return;
      const result = await customerPlacesApi.autocomplete(token, q, ctl.signal);
      if (ctl.signal.aborted || seq !== searchSeqRef.current || queryRef.current.trim() !== q) return;
      const list = (result ?? []).slice(0, 5);
      setSuggestions(list); setHasSearched(true);
      setSearchState(list.length === 0 ? 'empty' : 'ready');
    } catch (cause) {
      if (ctl.signal.aborted || isAbort(cause) || seq !== searchSeqRef.current) return;
      setSuggestions([]); setHasSearched(true); setSearchState('error');
      setSearchError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403) ? 'Sign in again to continue.' : 'Address search unavailable. Enter it manually.');
    }
  };
  const onSearchChange = (v: string) => {
    queryRef.current = v;
    setSearchQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    autocompleteCtlRef.current?.abort(); autocompleteCtlRef.current = null;
    searchSeqRef.current += 1;
    detailsCtlRef.current?.abort(); detailsCtlRef.current = null;
    selectionSeqRef.current += 1;
    setDetailsPending(false); setDetailsError(''); setSelectedPlace(''); setSelectedPincode(null);
    setSuggestions([]); setSearchState('idle'); setSearchError('');
    if (v.trim().length < 3) { setSuggestions([]); setSearchState('idle'); return; }
    debounceRef.current = setTimeout(() => void runSearch(v), 300);
  };
  const selectSuggestion = (s: PlaceSuggestion) => {
    const seq = ++selectionSeqRef.current;
    const id = s.id;
    detailsCtlRef.current?.abort();
    const ctl = new AbortController();
    detailsCtlRef.current = ctl;
    setDetailsPending(true); setDetailsError('');
    void (async () => {
      try {
        const token = await accessToken();
        if (ctl.signal.aborted) return;
        const details = await customerPlacesApi.details(token, id, ctl.signal);
        if (ctl.signal.aborted || seq !== selectionSeqRef.current) return;
        const loc = details?.location;
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) { setDetailsError('That place is unavailable. Choose another result.'); return; }
        const desc = details.description || s.description;
        setSelectedPlace(desc);
        const pin = typeof details.pincode === 'string' && /^\d{6}$/.test(details.pincode) ? details.pincode : null;
        setSelectedPincode(pin);
        setLine2(prev => prev.trim() === '' && desc.length > 0 && desc.length <= 200 ? desc : prev);
        if (pin) setPincode(prev => prev.trim() === '' ? pin : prev);
      } catch (cause) {
        if (ctl.signal.aborted || isAbort(cause) || seq !== selectionSeqRef.current) return;
        if (cause instanceof ApiError && (cause.status === 404 || cause.code === 'PLACE_NOT_FOUND')) setDetailsError('That place is unavailable. Choose another result.');
        else setDetailsError('Address search unavailable. Enter it manually.');
      } finally {
        if (seq === selectionSeqRef.current) setDetailsPending(false);
      }
    })();
  };
  const locate = async () => {
    setError(''); setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') throw new Error('Allow location access in your phone settings, then try again.');
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setPoint({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      setDeviceLocation(`Current location${loc.coords.accuracy ? ` (about ${Math.round(loc.coords.accuracy)} m accuracy)` : ''}`);
    } catch (cause) {
      setPoint(null); setDeviceLocation('');
      setErrors(p => ({ ...p, location: cause instanceof Error && cause.message.startsWith('Allow location') ? cause.message : 'Couldn’t get your location. Check GPS and try again.' }));
    } finally { setLocating(false); }
  };
  const clearField = (f: AddressField) => setErrors(p => ({ ...p, [f]: undefined }));
  const fieldError = (f: AddressField) => errors[f] ? <AppText accessibilityLiveRegion="polite" style={styles.error}>{errors[f]}</AppText> : null;

  const save = async () => {
    const next = addressErrors({ line1, line2, pincode, contact, phone, point });
    setErrors(next); setError('');
    const e164 = indianPhoneE164(phone);
    if (Object.keys(next).length || !e164) return;
    try {
      await onSave({ line1: line1.trim(), ...(line2.trim() ? { line2: line2.trim() } : {}), pincode, contactName: contact.trim(), contactPhone: e164, ...(point ?? {}) });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'INVALID_PINCODE') setErrors(p => ({ ...p, pincode: 'Enter a six-digit PIN code.' }));
      else if (cause instanceof ApiError && cause.code === 'INVALID_CONTACT_PHONE') setErrors(p => ({ ...p, phone: 'Enter a valid 10-digit Indian phone number.' }));
      else if (cause instanceof ApiError && cause.code === 'INVALID_COORDINATES') setErrors(p => ({ ...p, location: 'Select your current location again.' }));
      else if (cause instanceof ApiError && cause.code === 'ADDRESS_LIMIT_REACHED') setError('You have reached the saved address limit. Contact support to update an address.');
      else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setError(requestMessage(cause, 'save this address'));
      else if (cause instanceof ApiError && cause.code === 'INVALID_ADDRESS') setError('Check your house and street and contact name.');
      else if (cause instanceof Error && cause.message.includes('outside')) setErrors(p => ({ ...p, location: 'This location is outside our current delivery area.' }));
      else if (cause instanceof Error && cause.message.startsWith('Couldn’t check')) setError(cause.message);
      else setError(`${requestMessage(cause, 'save this address')} Check your saved addresses before retrying.`);
    }
  };

  return (
    <View style={{ gap: 9 }}>
      <TextInput style={[shared.input]} placeholder="Search a place or landmark" value={searchQuery} onChangeText={onSearchChange} maxLength={200} accessibilityLabel="Search a place or landmark" />
      {!hasSearched && (
        <View style={{ gap: 4 }}>
          <AppText style={shared.muted}>Location search by Ola Maps. Your search and the place you choose are shared with Ola Maps to show results.</AppText>
          <Pressable onPress={() => void Linking.openURL('https://maps.olakrutrim.com/legal/platform-privacy-policy').catch(() => undefined)} accessibilityRole="link" accessibilityLabel="Ola privacy notice"><AppText style={shared.muted}>Ola privacy notice</AppText></Pressable>
        </View>
      )}
      {searchState === 'loading' && <View style={styles.searchStatus}><ActivityIndicator size="small" color={colors.green} /><AppText accessibilityLiveRegion="polite" style={shared.muted}>Searching…</AppText></View>}
      {searchState === 'empty' && <AppText style={shared.muted}>No places found. Try a nearby landmark.</AppText>}
      {searchState === 'error' && <View style={{ gap: 4 }}><AppText style={shared.body}>{searchError}</AppText><Button label="Retry" size="sm" variant="soft" onPress={() => void runSearch(searchQuery)} /></View>}
      {suggestions.map(s => <Pressable key={s.id} onPress={() => selectSuggestion(s)} accessibilityRole="button" accessibilityLabel={`Select ${s.description}`}><AppText style={shared.body}>{s.description}</AppText></Pressable>)}
      {detailsPending && <View style={styles.searchStatus}><ActivityIndicator size="small" color={colors.green} /><AppText accessibilityLiveRegion="polite" style={shared.muted}>Loading place…</AppText></View>}
      {!!detailsError && <AppText style={shared.body}>{detailsError}</AppText>}
      <Button size="sm" label="Use current location" icon="locate-outline" variant="soft" loading={locating} onPress={() => void locate()} />
      {showLocationHint && <AppText style={shared.muted}>{locationRequired ? 'You can save the address now and confirm its location later. To order, confirm your location while you are at the delivery address.' : 'We check delivery using your PIN code. You can also share your location for your delivery partner.'}</AppText>}
      {!!selectedPlace && <AppText style={shared.muted}>Selected: {selectedPlace}</AppText>}
      {!!deviceLocation && <AppText style={shared.muted}>{deviceLocation}</AppText>}
      {fieldError('location')}
      <TextInput style={[shared.input, errors.line1 && styles.invalid]} placeholder="House and street" value={line1} onChangeText={v => { setLine1(v); clearField('line1'); }} maxLength={200} accessibilityLabel="House and street" />
      {fieldError('line1')}
      <TextInput style={[shared.input, errors.line2 && styles.invalid]} placeholder="Area and landmark (optional)" value={line2} onChangeText={v => { setLine2(v); clearField('line2'); }} maxLength={200} accessibilityLabel="Area and landmark" />
      {fieldError('line2')}
      <TextInput style={[shared.input, errors.pincode && styles.invalid]} placeholder="PIN code" value={pincode} onChangeText={v => { setPincode(v); clearField('pincode'); }} keyboardType="number-pad" maxLength={6} accessibilityLabel="PIN code" />
      {fieldError('pincode')}
      {!!selectedPincode && pincode.trim() && pincode.trim() !== selectedPincode && <AppText style={shared.body}>Check the PIN code for this address.</AppText>}
      <TextInput style={[shared.input, errors.contact && styles.invalid]} placeholder="Contact name" value={contact} onChangeText={v => { setContact(v); clearField('contact'); }} maxLength={120} accessibilityLabel="Contact name" />
      {fieldError('contact')}
      <View style={[shared.input, styles.phoneRow, errors.phone && styles.invalid]}><AppText style={styles.prefix}>+91</AppText><TextInput style={styles.phoneInput} placeholder="10-digit phone number" value={phone} onChangeText={v => { setPhone(indianPhoneInput(v)); clearField('phone'); }} keyboardType="phone-pad" autoComplete="tel-national" accessibilityLabel="Contact phone" /></View>
      {fieldError('phone')}
      {!!error && <AppText accessibilityLiveRegion="polite" style={styles.error}>{error}</AppText>}
      <Button label={saveLabel} fullWidth onPress={() => void save()} disabled={saving || locating} loading={saving} />
    </View>
  );
}
const styles = StyleSheet.create({ error: { color: colors.danger }, searchStatus: { flexDirection: 'row', alignItems: 'center', gap: 8 }, invalid: { borderColor: colors.danger }, phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, prefix: { color: colors.text, borderRightWidth: 1, borderRightColor: colors.lineStrong, paddingRight: 10 }, phoneInput: { flex: 1, minHeight: 46, color: colors.text, paddingVertical: 0 } });
