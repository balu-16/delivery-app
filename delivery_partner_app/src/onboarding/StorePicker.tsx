import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OnboardingStore } from "../api";
import { CardListSkeleton } from "../components/Skeleton";
import { Button, Card, IconBox, Text } from "../components/Ui";
import { colors, fonts } from "../theme";
import { fetchStoresIfNeeded, filterStores, peekCachedStores } from "./storeCache";
import type { HomeStore } from "./onboardingTypes";

type StorePickerProps = {
  accountId: string;
  confirmedStore: HomeStore | null;
  displayedStore: HomeStore | null;
  /** Optimistic store while a save is in flight; null means show confirmed. */
  saveStatus: "idle" | "saving" | "saved" | "error" | "unknown";
  error: string | null;
  editable: boolean;
  onSelect: (store: HomeStore) => void;
  onRetrySelect: (store: HomeStore) => void;
  lastAttemptedId: string | null;
};

/**
 * Compact store card + searchable modal with a virtualized list.
 * The picker never renders the full list inside the main ScrollView:
 * rows live in a FlatList inside the modal, filtered locally by
 * name/city, fully tappable with accessible selection state.
 */
export function StorePicker({
  accountId,
  confirmedStore,
  displayedStore,
  saveStatus,
  error,
  editable,
  onSelect,
  onRetrySelect,
  lastAttemptedId,
}: StorePickerProps) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stores, setStores] = useState<OnboardingStore[] | null>(() => peekCachedStores(accountId));
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listRefreshing, setListRefreshing] = useState(false);

  const load = useCallback(async (force: boolean, viaRefresh = false) => {
    if (viaRefresh) setListRefreshing(true);
    else setLoading(true);
    setListError(null);
    try {
      const items = await fetchStoresIfNeeded(accountId, force);
      setStores(items);
    } catch {
      setListError("Could not load stores. Please try again.");
      // Keep previously cached rows visible when a refresh fails.
      setStores((current) => current ?? null);
    } finally {
      if (viaRefresh) setListRefreshing(false);
      else setLoading(false);
    }
  }, [accountId]);

  // Parent remounts this component per account (key={accountId}), so a
  // signed-in change never reuses rows or an open sheet across accounts.
  // Fetching happens synchronously in openPicker (fetch on open if needed).
  const filtered = useMemo(() => filterStores(stores ?? [], query), [stores, query]);

  const openPicker = useCallback(() => {
    setQuery("");
    setOpen(true);
    if (!peekCachedStores(accountId)) void load(false);
    else setStores(peekCachedStores(accountId));
  }, [accountId, load]);

  const handlePressStore = useCallback((store: OnboardingStore) => {
    // One tap highlights the choice and returns to the form BEFORE any
    // network response. onSelect flips the optimistic card synchronously;
    // the write itself is queued by the caller.
    const home: HomeStore = { id: store.id, name: store.name, city: store.city };
    setOpen(false);
    setQuery("");
    onSelect(home);
  }, [onSelect]);

  const handleRetry = useCallback(() => {
    if (lastAttemptedId) {
      const attempted = displayedStore?.id === lastAttemptedId ? displayedStore : confirmedStore?.id === lastAttemptedId ? confirmedStore : null;
      const fromList = stores?.find((entry) => entry.id === lastAttemptedId);
      const retryStore = attempted ?? (fromList ? { id: fromList.id, name: fromList.name, city: fromList.city } : null);
      if (retryStore) {
        onRetrySelect(retryStore);
        return;
      }
    }
    setListError(null);
    void load(true);
  }, [confirmedStore, displayedStore, lastAttemptedId, load, onRetrySelect, stores]);

  const selectedId = displayedStore?.id ?? confirmedStore?.id ?? null;
  const busy = saveStatus === "saving";

  return (
    <>
      <Card>
        <View style={styles.row}>
          <IconBox name="storefront-outline" />
          <View style={{ flex: 1 }}>
            <Text style={styles.strong}>Your store</Text>
            <Text style={styles.sub}>A manager at this store will review your application.</Text>
          </View>
        </View>
        {/* Compact card: selected store + city only — never the full list. */}
        <View style={[styles.compactCard, selectedId && styles.compactSelected]}>
          <View style={{ flex: 1 }}>
            {displayedStore ? (
              <>
                <Text style={styles.strong}>{displayedStore.name}</Text>
                <Text style={styles.sub}>{displayedStore.city}</Text>
              </>
            ) : (
              <Text style={styles.sub}>No store selected</Text>
            )}
            {busy ? (
              <Text testID="store-saving" style={[styles.sub, styles.savingText]}>Saving store…</Text>
            ) : saveStatus === "saved" && displayedStore ? (
              <Text testID="store-selected" style={[styles.sub, styles.selectedText]}>Selected</Text>
            ) : saveStatus === "unknown" ? (
              <Text accessibilityRole="alert" style={styles.danger}>{error ?? "Couldn’t confirm the save. Tap Retry."}</Text>
            ) : error ? (
              <Text accessibilityRole="alert" style={styles.danger}>{error}</Text>
            ) : displayedStore ? (
              <Text testID="store-selected" style={[styles.sub, styles.selectedText]}>Selected</Text>
            ) : null}
          </View>
          {editable ? (
            <Button
              label={displayedStore ? "Change store" : "Choose store"}
              secondary
              compact
              disabled={busy}
              onPress={openPicker}
            />
          ) : displayedStore ? (
            <Text style={styles.selectedText}>Selected</Text>
          ) : null}
        </View>
        {(saveStatus === "error" || saveStatus === "unknown") && editable ? (
          <View style={styles.actionRow}>
            <Button label="Retry" secondary compact onPress={handleRetry} />
            <Text style={styles.helpHint}>Need help? Use Get help below.</Text>
          </View>
        ) : null}
      </Card>

      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        {open ? <View style={[styles.modalBackdrop, { paddingTop: insets.top }]}>
          <View style={[styles.modalSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.sheetTitle}>Choose your store</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close store picker"
                onPress={() => setOpen(false)}
                hitSlop={10}
              >
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            <TextInput
              accessibilityLabel="Search stores"
              value={query}
              onChangeText={setQuery}
              placeholder="Search by store name or city"
              placeholderTextColor={colors.muted}
              style={styles.search}
            />
            {loading && !stores ? (
              <CardListSkeleton label="Loading stores" count={3} />
            ) : listError && !stores ? (
              <View>
                <Text accessibilityRole="alert" style={styles.danger}>{listError}</Text>
                <Button label="Try again" secondary compact onPress={() => void load(true)} />
              </View>
            ) : (
              <FlatList
                testID="store-list"
                data={filtered}
                keyExtractor={(item) => item.id}
                keyboardShouldPersistTaps="handled"
                refreshControl={
                  <RefreshControl
                    testID="store-list-refresh"
                    refreshing={listRefreshing}
                    onRefresh={() => void load(true, true)}
                    tintColor={colors.greenDark}
                  />
                }
                renderItem={({ item }) => {
                  const selected = item.id === selectedId;
                  return (
                    <Pressable
                      key={item.id}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => handlePressStore(item)}
                      style={[styles.storeChoice, selected && styles.storeSelected]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.strong}>{item.name}</Text>
                        <Text style={styles.sub}>{item.city}</Text>
                      </View>
                      <Text style={styles.storeMarker}>{selected ? "Selected" : "Choose"}</Text>
                    </Pressable>
                  );
                }}
                ListEmptyComponent={
                  stores === null ? (
                    <CardListSkeleton label="Loading stores" count={3} />
                  ) : (
                    <Text style={styles.sub}>
                      {query.trim() ? "No stores match your search." : "No stores are available right now."}
                    </Text>
                  )
                }
              />
            )}
            {listError && stores && stores.length > 0 ? (
              <View style={styles.actionRow}>
                <Text accessibilityRole="alert" style={styles.danger}>{listError}</Text>
                <Button label="Try again" secondary compact onPress={() => void load(true)} />
              </View>
            ) : null}
          </View>
        </View> : null}
      </Modal>
    </>
  );
}



const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12, alignItems: "center", marginBottom: 10 },
  strong: { fontFamily: fonts.semibold, fontSize: 14 },
  sub: { fontSize: 11, color: colors.secondary, marginTop: 2 },
  savingText: { color: colors.greenDark, fontFamily: fonts.semibold },
  selectedText: { color: colors.greenDark, fontSize: 11, fontFamily: fonts.semibold, marginTop: 2 },
  danger: { color: colors.danger, marginVertical: 8, fontSize: 12 },
  compactCard: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, marginTop: 8 },
  compactSelected: { borderColor: colors.green, backgroundColor: colors.greenSoft },
  storeChoice: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, marginTop: 8 },
  storeSelected: { borderColor: colors.green, backgroundColor: colors.greenSoft },
  storeMarker: { color: colors.greenDark, fontSize: 11, fontFamily: fonts.semibold },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  helpHint: { fontSize: 11, color: colors.secondary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 16, maxHeight: "88%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sheetTitle: { fontFamily: fonts.semibold, fontSize: 16 },
  closeText: { color: colors.green, fontFamily: fonts.semibold, fontSize: 13 },
  search: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.backgroundTop, color: colors.text, paddingHorizontal: 12, minHeight: 48, borderRadius: 12, marginVertical: 10, fontFamily: fonts.regular, fontSize: 13 },
});
