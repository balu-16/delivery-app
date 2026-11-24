import { router } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, ErrorBanner, formatPaise, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';

export default function WalletPage() {
  const insets = useSafeAreaInsets();
  const wallet = useCustomer(s => s.wallet);
  const ledger = useCustomer(s => s.ledger);
  const accountLoad = useCustomer(s => s.accountLoad);
  const loadWallet = useCustomer(s => s.loadWallet);
  const loadLedger = useCustomer(s => s.loadLedger);

  useEffect(() => { void loadWallet(); void loadLedger(); }, [loadWallet, loadLedger]);
  const { refreshing, onRefresh } = useRefresh(async () => { await Promise.allSettled([loadWallet(), loadLedger()]); });

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title="Wallet" sub="Cash and promotional balances" onBack={() => router.canGoBack() ? router.back() : router.replace('/profile')} />
        <ErrorBanner />
        {accountLoad.wallet === 'idle' || accountLoad.wallet === 'loading' ? (
          <CardListSkeleton count={1} label="Loading wallet balance" />
        ) : accountLoad.wallet === 'error' ? (
          <Card><AppText style={shared.muted}>Couldn’t load your wallet.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadWallet()} /></Card>
        ) : (
          <Card>
            <AppText style={shared.label}>Cash balance {wallet ? formatPaise(wallet.cashPaise) : '—'}</AppText>
            <AppText style={shared.label}>Promotional balance {wallet ? formatPaise(wallet.promoPaise) : '—'}</AppText>
          </Card>
        )}
        <AppText style={shared.label}>Recent activity</AppText>
        {accountLoad.ledger === 'idle' || accountLoad.ledger === 'loading' ? (
          <CardListSkeleton count={2} label="Loading wallet activity" />
        ) : accountLoad.ledger === 'error' ? (
          <Card><AppText style={shared.muted}>Couldn’t load wallet activity.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadLedger()} /></Card>
        ) : ledger.length ? (
          ledger.map(item => (
            <Card key={item.id} style={styles.lineCard}>
              <AppText style={shared.body}>{item.reason.replaceAll('_', ' ').toLowerCase()}</AppText>
              <AppText style={shared.muted}>{item.createdAt ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(item.createdAt)) : ''} · {item.bucket}</AppText>
              <AppText style={shared.label}>{formatPaise(item.deltaPaise)}</AppText>
            </Card>
          ))
        ) : (
          <AppText style={shared.muted}>No activity to show.</AppText>
        )}
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ lineCard: { gap: 4 } });
