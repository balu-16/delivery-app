import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { agentClient } from '@/src/agent/client';
import { useRefresh } from '@/hooks/useRefresh';
import type { AgentThreadSummary } from '@/src/agent/types';

export default function ChatHistoryPage() {
  const insets = useSafeAreaInsets();
  const [chats, setChats] = useState<AgentThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (nextCursor?: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const page = await agentClient.threads(nextCursor);
      setChats(prev => (nextCursor ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch { setError('Couldn’t load your chats.'); } finally { setBusy(false); }
  }, [busy]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const { refreshing, onRefresh } = useRefresh(() => load());

  const open = (id: string) => {
    // Keep draft/pending confirmation bound to thread; agent.tsx handles consent via threadId param.
    router.push({ pathname: '/agent', params: { threadId: id } });
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title="All chats" sub="Your assistant conversations" onBack={() => router.canGoBack() ? router.back() : router.replace('/agent')} />
        {busy && chats.length === 0 ? <CardListSkeleton count={3} label="Loading chats" /> : chats.length === 0 && !busy && !error ? <AppText style={shared.muted}>No chats yet.</AppText> : null}
        {chats.map(chat => (
          <Pressable key={chat.id} onPress={() => open(chat.id)} accessibilityRole="button" accessibilityLabel={`Open chat ${chat.title ?? ''}`}>
            <Card style={styles.item}>
              <AppText style={shared.label}>{chat.title || 'New chat'}</AppText>
              <AppText style={shared.muted}>{new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(chat.lastMessageAt))}</AppText>
            </Card>
          </Pressable>
        ))}
        {!!error && <View><AppText style={{ color: colors.danger }}>{error}</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void load()} /></View>}
        {(cursor || error) && !busy && <Button label={error ? 'Try again' : 'Load more chats'} variant="soft" size="sm" onPress={() => void load(error ? undefined : cursor ?? undefined)} />}
        {busy && chats.length > 0 && <AppText style={shared.muted}>Loading chats…</AppText>}
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ item: { paddingVertical: 12 } });
