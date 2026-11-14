import { useState } from 'react';
import { Linking, Platform, StyleSheet, TextInput, View } from 'react-native';
import { ApiError, riderApi, UploadError, type Task } from '../api';
import { Button, Card, Chip, IconBox, PageTitle, Text } from '../components/Ui';
import { uploadProof } from '../files';
import { colors, fonts } from '../theme';
import { formatMoney } from './liveHelpers';

type Run = (action: string, body: unknown) => Promise<boolean>;
function parseRupees(value: string): string | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return (BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')).toString();
}
function openMap(lat: number | null, lng: number | null) {
  if (lat === null || lng === null) return;
  const url = Platform.OS === 'android' ? `geo:${lat},${lng}?q=${lat},${lng}`
    : Platform.OS === 'ios' ? `maps://?daddr=${lat},${lng}`
      : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  void Linking.openURL(url);
}

export function TaskDetail({ task, enabled, busy, run }: { task: Task; enabled: boolean; busy: boolean; run: Run }) {
  const [code, setCode] = useState('');
  const [cash, setCash] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [proofError, setProofError] = useState('');
  const [reason, setReason] = useState('CUSTOMER_UNREACHABLE');
  const [addressReason, setAddressReason] = useState('');
  const [contact, setContact] = useState<{ contactName: string; contactPhone: string } | null>(null);
  const [contactError, setContactError] = useState('');
  const [uploading, setUploading] = useState(false);
  const allowed = enabled && !busy && !uploading;
  const destination = task.destination;
  const customer = [destination.line1, destination.line2, destination.landmark, destination.pincode].filter(Boolean).join(', ');
  const isPrePickup = task.status === 'ASSIGNED' || task.status === 'AT_STORE';
  const codPaise = parseRupees(cash);
  async function chooseProof() {
    setUploading(true); setProofError('');
    try { const mediaId = await uploadProof(task.id); if (mediaId) setProof(mediaId); }
    catch (failure) { setProofError(failure instanceof ApiError || failure instanceof UploadError ? failure.message : 'Could not upload proof. Please try again.'); }
    finally { setUploading(false); }
  }
  async function showContact() {
    setContactError('');
    try { const info = await riderApi.contact(task.id); if (!info) throw new Error('Contact details are not available for this delivery.'); setContact(info); }
    catch (failure) { setContactError(failure instanceof Error ? failure.message : 'Could not load contact details.'); }
  }
  return <>
    <PageTitle title={`Order ${task.orderNumber}`} subtitle={task.status.replaceAll('_', ' ')} />
    <Card><View style={styles.row}><IconBox name="storefront-outline" /><View style={{ flex: 1 }}>
      <Text style={styles.strong}>{task.store.name}</Text><Text style={styles.sub}>Pickup location</Text>
    </View></View><Button label="Navigate to store" secondary compact onPress={() => openMap(task.store.lat, task.store.lng)} />
    {isPrePickup && task.handoverCode ? <View style={styles.callout}><Text style={styles.sub}>Show this code to the store</Text><Text style={styles.code}>{task.handoverCode}</Text></View> : null}
    </Card>
    <Card><View style={styles.row}><IconBox name="location-outline" /><View style={{ flex: 1 }}>
      <Text style={styles.strong}>{destination.name || 'Customer'}</Text><Text style={styles.sub}>{customer || 'Address unavailable'}</Text>
    </View></View>
      {destination.lat !== null && destination.lng !== null ? <Button label="Navigate to customer" secondary compact onPress={() => openMap(destination.lat, destination.lng)} /> : null}
      <View style={styles.space} /><Button label="Show customer contact" secondary compact disabled={!allowed} onPress={() => void showContact()} />
      {contact ? <Button label={`Call ${contact.contactName}`} compact onPress={() => void Linking.openURL(`tel:${contact.contactPhone}`)} /> : null}
      {contactError ? <Text style={styles.error}>{contactError}</Text> : null}
    </Card>
    {task.items.length > 0 ? <Card><Text style={styles.strong}>Order items</Text>{task.items.map((item, index) => <Text key={`${item.name}-${index}`} style={styles.sub}>{item.quantity} × {item.name}</Text>)}</Card> : null}
    {task.status === 'ASSIGNED' ? <Button label="Arrived at store" disabled={!allowed} onPress={() => void run('arrived-at-store', {})} /> : null}
    {task.status === 'AT_STORE' ? <Button label="Confirm pickup" disabled={!allowed} onPress={() => void run('picked-up', {})} /> : null}
    {task.status === 'PICKED_UP' ? <Button label="Arrived at customer" disabled={!allowed} onPress={() => void run('arrived', {})} /> : null}
    {task.status === 'ARRIVED' ? <>
      <Card><Text style={styles.strong}>Delivery confirmation</Text>
        {task.codAmountPaise !== null ? <>
          <Text style={styles.sub}>Cash due: {formatMoney(task.codAmountPaise)}</Text>
          {task.codCollectedPaise !== null ? <Text style={styles.strong}>Recorded cash: {formatMoney(task.codCollectedPaise)}</Text> : <>
            <TextInput style={styles.input} accessibilityLabel="Cash collected in rupees" value={cash} onChangeText={setCash} keyboardType="decimal-pad" placeholder="Cash collected in rupees" placeholderTextColor={colors.muted} />
            <Button label="Record cash collected" secondary compact disabled={!allowed || !codPaise} onPress={() => void run('cod-collect', { amountPaise: codPaise })} />
          </>}
          {task.codCollectedPaise !== null && task.codCollectedPaise !== task.codAmountPaise ? <Text style={styles.error}>Cash does not match the amount due. Contact support.</Text> : null}
        </> : null}
        <Text style={[styles.sub, { marginTop: 14 }]}>Enter the customer&apos;s four-digit delivery code, or upload a delivery photo.</Text>
        <TextInput style={styles.input} accessibilityLabel="Delivery code" value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" maxLength={4} placeholder="4-digit code" placeholderTextColor={colors.muted} />
        <Button label={proof ? 'Delivery photo uploaded' : 'Upload delivery photo'} secondary compact disabled={!allowed} onPress={() => void chooseProof()} />
        {proofError ? <Text style={styles.error}>{proofError}</Text> : null}
        <View style={styles.space} />
        <Button label="Complete delivery" disabled={!allowed || (code.length !== 4 && !proof) || (task.codAmountPaise !== null && task.codCollectedPaise !== task.codAmountPaise)}
          onPress={() => void run('deliver', code.length === 4 ? { deliveryCode: code } : { podMediaId: proof })} />
      </Card>
      <Card><Text style={styles.strong}>Having trouble?</Text><Text style={styles.sub}>Record contact attempts before reporting an unreachable customer.</Text>
        <View style={styles.space} /><Button label="Record contact attempt" secondary compact disabled={!allowed} onPress={() => void run('contact-attempts', {})} />
        <TextInput style={styles.input} value={addressReason} onChangeText={setAddressReason} placeholder="Describe a wrong address" placeholderTextColor={colors.muted} />
        <Button label="Report wrong address" secondary compact disabled={!allowed || !addressReason.trim()} onPress={() => void run('wrong-address', { reason: addressReason.trim() })} />
      </Card>
    </> : null}
    <Card><Text style={styles.strong}>{isPrePickup ? 'Release assignment' : 'Report delivery problem'}</Text>
      {!isPrePickup ? <View style={styles.chips}>{[
        ['CUSTOMER_UNREACHABLE', 'Customer unreachable'], ['PACKAGE_DAMAGED', 'Package damaged'],
        ['VEHICLE_BREAKDOWN', 'Vehicle breakdown'], ...(task.codAmountPaise !== null ? [['COD_REFUSED', 'Cash refused']] : []),
      ].map(([value, label]) => <Chip key={value} label={label!} active={reason === value} onPress={() => setReason(value!)} />)}</View> : <Text style={styles.sub}>The order will be returned to dispatch before pickup.</Text>}
      <Button label={isPrePickup ? 'Release assignment' : 'Report failed delivery'} secondary compact disabled={!allowed}
        onPress={() => void run('fail', { reason: isPrePickup ? 'RIDER_UNAVAILABLE' : reason })} />
    </Card>
  </>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 12 }, strong: { fontSize: 14, fontFamily: fonts.semibold },
  sub: { fontSize: 12, color: colors.secondary, marginTop: 4, lineHeight: 19 }, callout: { backgroundColor: colors.greenSoft, borderRadius: 12, alignItems: 'center', padding: 10, marginTop: 12 },
  code: { fontSize: 25, color: colors.greenDark, fontFamily: fonts.bold, letterSpacing: 4 }, space: { height: 10 },
  input: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.backgroundTop, color: colors.text, paddingHorizontal: 12, minHeight: 48, borderRadius: 12, marginVertical: 10, fontFamily: fonts.regular },
  error: { color: colors.danger, fontSize: 12, marginTop: 8 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 12 } });
