import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, riderApi, UploadError, type Application, type OnboardingStore } from '../api';
import { Brand } from '../components/Brand';
import { Button, Card, IconBox, PageTitle, Text } from '../components/Ui';
import { uploadDocument } from '../files';
import { colors, fonts } from '../theme';

const names: Record<string, string> = { licence: 'Driving licence', vehicle_rc: 'Vehicle registration', id_proof: 'Identity proof', bank_proof: 'Bank proof' };
export function ApplicationScreen({ application, reload, signOut }: { application: Application; reload: () => Promise<void>; signOut: () => Promise<void> }) {
  const insets = useSafeAreaInsets();
  const [vehicle, setVehicle] = useState(application.vehicleType ?? '');
  const [number, setNumber] = useState(application.vehicleNo ?? '');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<string | null>(null);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [stores, setStores] = useState<OnboardingStore[]>([]);
  const [storeError, setStoreError] = useState('');
  const [storeRetry, setStoreRetry] = useState(0);
  const editable = application.status === 'PENDING' || application.status === 'REJECTED';
  useEffect(() => {
    let active = true;
    riderApi.onboardingStores().then((items) => { if (active) { setStores(items); setStoreError(''); } })
      .catch(() => { if (active) setStoreError('Could not load stores. Please try again.'); });
    return () => { active = false; };
  }, [storeRetry]);
  async function perform(work: () => Promise<unknown>, documentType: string | null = null, refreshAfter = true) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(''); setErrorType(null); setUploadingType(documentType);
    try { await work(); if (refreshAfter) await reload(); }
    catch (failure) {
      setErrorType(documentType);
      setError(failure instanceof ApiError || failure instanceof UploadError ? failure.message : 'Could not complete the request. Please try again.');
    }
    finally { busyRef.current = false; setBusy(false); setUploadingType(null); }
  }
  return <View style={[styles.root, { paddingTop: insets.top }]}>
    <View style={styles.header}><Brand /><Button label="Sign out" secondary compact onPress={() => {
      setErrorType(null); setError('');
      void signOut().catch((failure: unknown) => setError(failure instanceof ApiError ? failure.message : 'Could not sign out. Please try again.'));
    }} /></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}>
      <PageTitle title={application.status === 'APPROVED' ? 'Application approved' : application.status === 'SUSPENDED' ? 'Account suspended' : 'Your partner application'}
        subtitle={application.status === 'UNDER_REVIEW' ? 'Your documents are being reviewed. You can check back here for updates.'
          : application.status === 'REJECTED' ? 'Please update the documents that need attention and resubmit them.'
          : application.status === 'SUSPENDED' ? 'Contact support for help with your account.'
          : 'Add your vehicle details and documents to get started.'} />
      <Card><View style={styles.row}><IconBox name="shield-checkmark-outline" /><View style={{ flex: 1 }}>
        <Text style={styles.strong}>Application status</Text><Text style={styles.sub}>{application.status.replaceAll('_', ' ')}</Text>
      </View></View></Card>
      <Card><View style={styles.row}><IconBox name="storefront-outline" /><View style={{ flex: 1 }}>
        <Text style={styles.strong}>Your store</Text>
        <Text style={styles.sub}>A manager at this store will review your application.</Text>
      </View></View>
        {stores.map((store) => {
          const selected = store.id === application.homeStoreId;
          if (!editable && !selected) return null;
          return <Pressable key={store.id} accessibilityRole="radio" accessibilityState={{ selected, disabled: busy || !editable }}
            disabled={busy || !editable || selected} onPress={() => void perform(() => riderApi.selectOnboardingStore(store.id))}
            style={[styles.storeChoice, selected && styles.storeSelected]}>
            <View style={{ flex: 1 }}><Text style={styles.strong}>{store.name}</Text><Text style={styles.sub}>{store.city}</Text></View>
            <Text style={styles.storeMarker}>{selected ? 'Selected' : 'Choose'}</Text>
          </Pressable>;
        })}
        {!stores.length && !storeError && <Text style={styles.sub}>Loading stores…</Text>}
        {storeError ? <><Text accessibilityRole="alert" style={styles.danger}>{storeError}</Text>
          <Button label="Try again" secondary compact onPress={() => setStoreRetry((value) => value + 1)} /></> : null}
      </Card>
      {editable && <Card><Text style={styles.strong}>Vehicle details</Text>
        <Text style={styles.label}>Vehicle type</Text><TextInput accessibilityLabel="Vehicle type" value={vehicle} onChangeText={setVehicle} placeholder="Bike or scooter" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.label}>Registration number</Text><TextInput accessibilityLabel="Registration number" value={number} onChangeText={setNumber} autoCapitalize="characters" placeholder="Vehicle number" placeholderTextColor={colors.muted} style={styles.input} />
        <Button label="Save vehicle" disabled={busy || !vehicle.trim() || !number.trim()} onPress={() => void perform(() => riderApi.profile(vehicle.trim(), number.trim()))} />
      </Card>}
      <Text style={styles.section}>Required documents</Text>
      <Text style={styles.documentHint}>Choose a clear JPEG, PNG or PDF file, up to 5 MB each.</Text>
      {application.requiredDocuments.map((type) => {
        const document = application.documents.find((item) => item.type === type);
        return <Card key={type}><View style={styles.row}><IconBox name="document-text-outline" /><View style={{ flex: 1 }}>
          <Text style={styles.strong}>{names[type] ?? type.replaceAll('_', ' ')}</Text>
          <Text style={styles.sub}>{document?.status === 'APPROVED' ? 'Approved' : document?.status === 'REJECTED' ? 'Needs a new document' : document ? 'Submitted' : 'Not uploaded'}</Text>
          {document?.reason ? <Text style={styles.danger}>{document.reason}</Text> : null}
        </View></View>
        {editable && document?.status !== 'APPROVED' && <Button label={uploadingType === type ? 'Uploading…' : document ? 'Upload replacement' : 'Upload document'} secondary compact disabled={busy} onPress={() => void perform(() => uploadDocument(type), type)} />}
        {error && errorType === type ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
        </Card>;
      })}
      {error && !errorType ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
      <Button label="Refresh status" secondary disabled={busy} onPress={() => void perform(reload, null, false)} />
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, header: { paddingHorizontal: 18, minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  content: { padding: 18, maxWidth: 560, width: '100%', alignSelf: 'center' }, row: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 10 },
  strong: { fontFamily: fonts.semibold, fontSize: 14 }, sub: { fontSize: 11, color: colors.secondary, marginTop: 2 },
  section: { fontSize: 16, fontFamily: fonts.semibold, marginVertical: 12 }, label: { fontSize: 11, color: colors.secondary, marginTop: 12 },
  documentHint: { fontSize: 11, color: colors.secondary, marginBottom: 12, lineHeight: 18 },
  input: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.backgroundTop, color: colors.text, paddingHorizontal: 12, minHeight: 48, borderRadius: 12, marginVertical: 7, fontFamily: fonts.regular },
  danger: { color: colors.danger, marginVertical: 8, fontSize: 12 },
  storeChoice: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, marginTop: 8 },
  storeSelected: { borderColor: colors.green, backgroundColor: colors.greenSoft },
  storeMarker: { color: colors.greenDark, fontSize: 11, fontFamily: fonts.semibold },
});
