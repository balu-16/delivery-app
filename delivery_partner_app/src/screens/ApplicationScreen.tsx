import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ApiError, type Application } from '../api';
import { Brand } from '../components/Brand';
import { Button, Card, IconBox, PageTitle, Text } from '../components/Ui';
import { useRefresh } from '../useRefresh';
import { colors, fonts } from '../theme';
import { useOnboardingState } from '../onboarding/useOnboardingState';
import { StorePicker } from '../onboarding/StorePicker';
import { VehicleForm } from '../onboarding/VehicleForm';
import { DocumentRows } from '../onboarding/DocumentRows';
import { clearStoreCache } from '../onboarding/storeCache';
import type { HomeStore } from '../onboarding/onboardingTypes';

const applicationStatusLabels = {
  PENDING: 'Incomplete',
  UNDER_REVIEW: 'Under review',
  REJECTED: 'Changes requested',
  SUSPENDED: 'Suspended',
  APPROVED: 'Approved',
} satisfies Record<Application['status'], string>;

/**
 * Rider onboarding application screen (plan.md §3).
 *
 * One account-scoped state holds the confirmed snapshot, per-section drafts
 * and statuses, and one write queue. Store saves, vehicle saves, and document
 * attachment commits enter the queue; picking, transfer, and reads stay
 * outside it. A successful write applies the returned snapshot with zero
 * follow-up GETs; a legacy void response reconciles via one scoped read.
 */
export function ApplicationScreen({ application, onApplicationChange, signOut, accountId }: {
  application: Application;
  onApplicationChange?: (application: Application) => void;
  signOut: () => Promise<void>;
  accountId?: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const resolvedAccountId = accountId ?? application.userId;
  const onboarding = useOnboardingState(resolvedAccountId, application, onApplicationChange);
  const {
    confirmed,
    store,
    vehicle,
    documents,
    refreshApplication,
    saveStore,
    setVehicleDraft,
    markVehicleDirty,
    saveVehicle,
    retryVehicle,
    setDocumentRow,
    commitDocument,
    confirmedStore,
    displayedStore,
  } = onboarding;
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [lastAttemptedStore, setLastAttemptedStore] = useState<HomeStore | null>(null);

  // Pull-to-refresh the application while keeping the form, selection, and
  // uploaded rows visible. Skeletons never clear already-loaded content.
  const pull = useRefresh(async () => {
    setRefreshError('');
    try { await refreshApplication(); }
    catch { setRefreshError('Couldn’t refresh your application. Pull to try again.'); }
  });

  const editable = confirmed.status === 'PENDING' || confirmed.status === 'REJECTED';
  const helpAllowed = confirmed.status === 'PENDING' || confirmed.status === 'REJECTED' || confirmed.status === 'UNDER_REVIEW';

  const handleSelectStore = useCallback((next: HomeStore) => {
    setLastAttemptedStore(next);
    saveStore(next);
  }, [saveStore]);

  const handleVehicleTypeChange = useCallback((value: string) => {
    markVehicleDirty('vehicleType');
    setVehicleDraft({ vehicleType: value });
  }, [markVehicleDirty, setVehicleDraft]);

  const handleVehicleNumberChange = useCallback((value: string) => {
    markVehicleDirty('vehicleNo');
    // Normalize registration letters to uppercase on the wire; the draft
    // keeps what the rider typed until confirmation.
    setVehicleDraft({ vehicleNo: value });
  }, [markVehicleDirty, setVehicleDraft]);

  const canSaveVehicle = vehicle.status !== 'saving' && onboarding.isVehicleDirty
    && onboarding.isVehicleDraftValid(vehicle.draft)
    && (!vehicle.error || onboarding.vehicleEditedAfterFailure);

  const openHelp = useCallback((operation: string, reference?: string) => {
    if (!helpAllowed) return;
    const suffix = reference ? ` Reference: ${reference}.` : '';
    router.push({ pathname: '/support/index', params: { category: 'ONBOARDING', onboarding: '1', prefill: `I need help with my partner application. Operation: ${operation}.${suffix}\nDetails: ` } } as never);
  }, [helpAllowed, router]);

  const handleSignOut = useCallback(async () => {
    setError('');
    try {
      clearStoreCache(resolvedAccountId);
      await signOut();
    } catch (failure: unknown) {
      setError(failure instanceof ApiError ? failure.message : 'Could not sign out. Please try again.');
    }
  }, [resolvedAccountId, signOut]);

  return <View style={[styles.root, { paddingTop: insets.top }]}>
    <View style={styles.header}><Brand /><View style={{ flexDirection: 'row', gap: 8 }}><Button label="Help" secondary compact onPress={() => router.push({ pathname: '/support/index', params: { onboarding: '1' } } as never)} /><Button label="Sign out" secondary compact onPress={() => { void handleSignOut(); }} /></View></View>
    <ScrollView testID="application-scroll" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { flexGrow: 1, paddingBottom: insets.bottom + 30 }]}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={() => { void pull.onRefresh(); }} tintColor={colors.greenDark} />}>
      <PageTitle title={confirmed.status === 'APPROVED' ? 'Application approved' : confirmed.status === 'SUSPENDED' ? 'Account suspended' : 'Your partner application'}
        subtitle={confirmed.status === 'UNDER_REVIEW' ? 'Your application has been submitted. The decision will appear here.'
          : confirmed.status === 'REJECTED' ? 'Review the requested changes. Saving the required updates sends your application back for review.'
          : confirmed.status === 'SUSPENDED' ? 'Contact support for help with your account.'
          : confirmed.status === 'APPROVED' ? undefined
          : 'Choose a store, save your vehicle details, and upload the required documents. Your application is submitted when all three are complete.'} />
      {refreshError ? <Text accessibilityRole="alert" style={styles.danger}>{refreshError}</Text> : null}
      <Card><View style={styles.row}><IconBox name="shield-checkmark-outline" /><View style={{ flex: 1 }}>
        <Text style={styles.strong}>Application status</Text><Text accessibilityLiveRegion="polite" style={styles.sub}>{applicationStatusLabels[confirmed.status]}</Text>
      </View></View></Card>

      <StorePicker
        key={`store:${resolvedAccountId}`}
        accountId={resolvedAccountId}
        confirmedStore={confirmedStore}
        displayedStore={displayedStore}
        saveStatus={store.status}
        error={store.error}
        editable={editable}
        onSelect={handleSelectStore}
        onRetrySelect={handleSelectStore}
        lastAttemptedId={lastAttemptedStore?.id ?? null}
      />
      {helpAllowed && editable && (store.status === 'error' || store.status === 'unknown') ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Get help with store selection" onPress={() => openHelp('select store', store.reference)}>
          <Text style={styles.helpLink}>Get help</Text>
        </Pressable>
      ) : null}

      {editable ? (
        <>
          <VehicleForm
            vehicleType={vehicle.draft.vehicleType}
            vehicleNo={vehicle.draft.vehicleNo}
            saving={vehicle.status === 'saving'}
            saved={vehicle.status === 'saved'}
            error={vehicle.error}
            canSave={canSaveVehicle}
            onTypeChange={handleVehicleTypeChange}
            onNumberChange={handleVehicleNumberChange}
            onSave={saveVehicle}
            onRetry={retryVehicle}
          />
          {helpAllowed && (vehicle.status === 'error' || vehicle.status === 'unknown') ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Get help with vehicle details" onPress={() => openHelp('save vehicle', vehicle.reference)}>
              <Text style={styles.helpLink}>Get help</Text>
            </Pressable>
          ) : null}
        </>
      ) : confirmed.vehicleType || confirmed.vehicleNo ? (
        <Card>
          <Text style={styles.strong}>Vehicle details</Text>
          <Text style={styles.sub}>{confirmed.vehicleType ?? ''}</Text>
          <Text style={styles.sub}>{confirmed.vehicleNo ?? ''}</Text>
        </Card>
      ) : null}

      <DocumentRows
        key={`documents:${resolvedAccountId}`}
        application={confirmed}
        maxDocumentBytes={confirmed.maxDocumentBytes ?? 5 * 1024 * 1024}
        editable={editable}
        rowStates={documents}
        onRowState={setDocumentRow}
        onCommit={commitDocument}
        accountId={resolvedAccountId}
        onHelp={openHelp}
      />

      {helpAllowed ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Get help with onboarding" onPress={() => openHelp('onboarding')}>
          <Text style={styles.helpLink}>Get help</Text>
        </Pressable>
      ) : null}

      {error ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, header: { paddingHorizontal: 18, minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  content: { padding: 18, maxWidth: 560, width: '100%', alignSelf: 'center' }, row: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 10 },
  strong: { fontFamily: fonts.semibold, fontSize: 14 }, sub: { fontSize: 11, color: colors.secondary, marginTop: 2 },
  danger: { color: colors.danger, marginVertical: 8, fontSize: 12 },
  helpLink: { color: colors.green, fontFamily: fonts.semibold, fontSize: 12, marginVertical: 8 },
});
