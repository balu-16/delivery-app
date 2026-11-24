import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, Share, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { Card, formatPaise, shared } from '@/components/connected/Shared';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { colors } from '@/constants/theme';
import { referralsApi, shareInviteMessage, shareReferralMessage } from '@/src/api/referrals';
import type { ReferralHistoryItem, ReferralHistoryStatus, ReferralInviteCreated, ReferralView } from '@/src/api/referrals';
import { ApiError } from '@/src/api/client';
import { accessToken } from '@/src/auth/session';
import { useRefresh } from '@/hooks/useRefresh';

const date = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d);
};
const shortRef = (id: string) => `Ref ${id.slice(0, 8).toUpperCase()}`;

export default function Referrals() {
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<ReferralView | null>(null);
  const [viewState, setViewState] = useState<'loading' | 'success' | 'error'>('loading');
  const [filter, setFilter] = useState<ReferralHistoryStatus>('successful');
  const [items, setItems] = useState<Record<ReferralHistoryStatus, ReferralHistoryItem[]>>({ successful: [], pending: [] });
  const [cursors, setCursors] = useState<Record<ReferralHistoryStatus, string | null>>({ successful: null, pending: null });
  const [loaded, setLoaded] = useState<Record<ReferralHistoryStatus, boolean>>({ successful: false, pending: false });
  const [historyState, setHistoryState] = useState<'loading' | 'success' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const [created, setCreated] = useState<ReferralInviteCreated | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const viewRequest = useRef(0);
  const historyRequest = useRef(0);
  const codeInput = useRef<ComponentRef<typeof TextInput>>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeItems = items[filter];
  const activeCursor = cursors[filter];
  const disabled = viewState === 'success' && (!view?.enabled || !view?.code);

  const loadView = useCallback(async (): Promise<void> => {
    const requestId = ++viewRequest.current;
    try {
      const result = await referralsApi.view(await accessToken());
      if (requestId === viewRequest.current) { setView(result); setViewState('success'); }
    } catch {
      if (requestId === viewRequest.current) { setViewState(state => (state === 'success' ? state : 'error')); setError('Couldn’t load referral details.'); }
    }
  }, []);

  const loadHistory = useCallback(
    async (status: ReferralHistoryStatus, refresh = false, appendCursor?: string): Promise<void> => {
      const requestId = ++historyRequest.current;
      if (appendCursor) setLoadingMore(true);
      try {
        const result = await referralsApi.history(await accessToken(), status, appendCursor, 20);
        if (requestId === historyRequest.current) {
          setItems(previous => ({ ...previous, [status]: appendCursor ? [...previous[status], ...result.items] : result.items }));
          setCursors(previous => ({ ...previous, [status]: result.nextCursor }));
          setLoaded(previous => ({ ...previous, [status]: true }));
          setHistoryState('success');
        }
      } catch {
        if (requestId === historyRequest.current) {
          setHistoryState(state => (state === 'success' ? state : 'error'));
          setError(status === 'successful' ? 'Couldn’t load successful referrals.' : 'Couldn’t load pending invites.');
        }
      } finally {
        if (requestId === historyRequest.current && appendCursor) setLoadingMore(false);
      }
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      void loadView();
      void loadHistory('successful');
      return () => { if (copyTimer.current) clearTimeout(copyTimer.current); };
    }, [loadView, loadHistory]),
  );

  const changeFilter = (next: ReferralHistoryStatus) => {
    setError('');
    setFilter(next);
    if (!loaded[next]) { setHistoryState('loading'); void loadHistory(next); }
  };

  const { refreshing, onRefresh } = useRefresh(async () => {
    await loadView();
    await loadHistory(filter, true);
  });

  const copyCode = async () => {
    if (!view?.code || disabled) return;
    setCopyFeedback('Copied');
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(view.code);
      }
    } catch { /* The code stays selectable below for manual copy. */ }
    if (Platform.OS !== 'web') {
      codeInput.current?.focus();
      codeInput.current?.setNativeProps?.({ selection: { start: 0, end: view.code.length } });
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyFeedback(''), 2000);
  };

  const sharePermanent = async () => {
    if (!view?.code || disabled) return;
    setActionError('');
    try { await Share.share({ message: shareReferralMessage(view.code) }); }
    catch { setActionError('Couldn’t open the share sheet.'); }
  };

  const shareInvite = async (inviteCode: string): Promise<boolean> => {
    setActionError('');
    try { await Share.share({ message: shareInviteMessage(inviteCode) }); return true; }
    catch { setActionError('Couldn’t open the share sheet.'); return false; }
  };

  const createAndShare = async () => {
    if (creating || disabled || !view?.code) return;
    const trimmed = label.trim();
    if (trimmed.length > 48) { setActionError('Keep the note to 48 characters.'); return; }
    if (created) {
      if (await shareInvite(created.code)) setCreated(null);
      return;
    }
    const key = failedKey ?? randomUUID();
    setCreating(true);
    setActionError('');
    try {
      const invite = await referralsApi.createInvite(await accessToken(), trimmed || undefined, key);
      setFailedKey(null);
      setCreated(invite);
      setLabel('');
      // Pending shows invite creation even when the share sheet is dismissed.
      void loadHistory('pending', true);
      if (await shareInvite(invite.code)) setCreated(null);
    } catch (cause) {
      setFailedKey(key);
      if (cause instanceof ApiError && cause.code === 'REFERRALS_UNAVAILABLE') setActionError('Referral rewards are unavailable right now.');
      else if (cause instanceof ApiError && cause.code === 'RATE_LIMITED') setActionError('Too many invites right now. Try again in a minute.');
      else setActionError('Couldn’t create the invite. Try again.');
    } finally { setCreating(false); }
  };

  const visibleError = error || actionError;
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}
      >
        <View style={shared.row}>
          <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <AppText style={shared.label}>Referrals</AppText>
          </View>
        </View>
        {viewState === 'loading' && !view ? (
          <CardListSkeleton label="Loading referral details" count={1} />
        ) : viewState === 'error' && !view ? (
          <Card>
            <AppText style={shared.body}>Couldn’t load referral details.</AppText>
            <Button label="Try again" size="sm" variant="soft" onPress={() => void loadView()} />
          </Card>
        ) : view ? (
          <Card>
            {view.freeDeliveryAvailable && (
              <><AppText style={shared.label}>Free delivery is ready</AppText><AppText style={shared.body}>It will be applied automatically to your next order.</AppText></>
            )}
            <AppText style={shared.label}>Your referral ID</AppText>
            {view.enabled && view.code ? (
              <>
                <TextInput ref={codeInput} editable={false} value={view.code} accessibilityLabel="Your referral ID" style={shared.input} />
                <AppText style={shared.muted}>{view.successfulReferrals} verified {view.successfulReferrals === 1 ? 'friend' : 'friends'} joined · {view.pendingReferrals} pending {view.pendingReferrals === 1 ? 'invite' : 'invites'}</AppText>
                <Button label="Copy code" fullWidth variant="soft" disabled={disabled} onPress={() => void copyCode()} />
                {!!copyFeedback && <AppText accessibilityLiveRegion="polite" style={shared.muted}>{copyFeedback}</AppText>}
                <Button label="Share invite" fullWidth disabled={disabled} onPress={() => void sharePermanent()} />
              </>
            ) : (
              <AppText style={shared.body}>Referral rewards are temporarily unavailable.</AppText>
            )}
          </Card>
        ) : null}
        {view && view.enabled && view.code ? (
          <AppText style={shared.body}>When a new friend signs up with your code and verifies their email, you receive {formatPaise(view.rewardPaise)} in promotional wallet credit. It expires {view.rewardExpiryMonths === 1 ? 'one calendar month' : `${view.rewardExpiryMonths} calendar months`} after it is granted. Your friend gets one free delivery on their next order.</AppText>
        ) : null}
        {!!visibleError && <AppText accessibilityLiveRegion="polite" style={{ color: colors.danger }}>{visibleError}</AppText>}
        <View style={shared.row}>
          <Chip label={`Successful${view ? ` (${view.successfulReferrals})` : ''}`} active={filter === 'successful'} onPress={() => changeFilter('successful')} />
          <Chip label={`Pending${view ? ` (${view.pendingReferrals})` : ''}`} active={filter === 'pending'} onPress={() => changeFilter('pending')} />
        </View>
        {filter === 'pending' && (
          <View style={{ gap: 8 }}>
            <TextInput style={shared.input} value={label} onChangeText={value => { setLabel(value); setCreated(null); setFailedKey(null); }} placeholder="Private note (optional)" maxLength={48} accessibilityLabel="Private note" />
            <AppText style={shared.muted}>Private note · {label.length}/48. Only you can see it.</AppText>
            <Button label={created ? 'Share the created invite' : 'Create invite & share'} fullWidth disabled={creating || disabled || !view?.code} loading={creating} onPress={() => void createAndShare()} />
            {created && <AppText style={shared.body}>Created {created.code}. You can share the same invite again until it is used.</AppText>}
          </View>
        )}
        {historyState === 'loading' && !loaded[filter] ? (
          <CardListSkeleton label={filter === 'successful' ? 'Loading successful referrals' : 'Loading pending invites'} count={2} />
        ) : historyState === 'error' && !loaded[filter] ? (
          <Card>
            <AppText style={shared.body}>{filter === 'successful' ? 'Couldn’t load successful referrals.' : 'Couldn’t load pending invites.'}</AppText>
            <Button label="Try again" size="sm" variant="soft" onPress={() => void loadHistory(filter, true)} />
          </Card>
        ) : activeItems.length ? (
          activeItems.map(item => (
            <Card key={item.id}>
              <AppText style={shared.muted}>{shortRef(item.id)}</AppText>
              {!!item.label && <AppText style={shared.label}>{item.label}</AppText>}
              <AppText style={shared.body}>{date(item.createdAt)}</AppText>
              {item.status === 'successful' ? (
                <>
                  <AppText style={shared.label}>{item.rewardPaise ? formatPaise(item.rewardPaise) : formatPaise(view?.rewardPaise ?? '1000')} confirmed</AppText>
                  {!!item.creditExpiresAt && <AppText style={shared.muted}>Credit expires {date(item.creditExpiresAt)}</AppText>}
                </>
              ) : (
                <>
                  <AppText style={shared.body}>Awaiting verified signup</AppText>
                  {!!item.inviteCode && (
                    <>
                      <AppText selectable style={shared.body}>{item.inviteCode}</AppText>
                      <Button label="Share again" size="sm" variant="soft" disabled={disabled} onPress={() => void shareInvite(item.inviteCode!)} />
                    </>
                  )}
                </>
              )}
            </Card>
          ))
        ) : (
          <AppText style={shared.muted}>{filter === 'successful' ? 'No successful referrals yet.' : 'No pending invites yet. Share an invite to track it here.'}</AppText>
        )}
        {!!activeCursor && (
          <Button label={loadingMore ? 'Loading more…' : 'Load more'} size="sm" variant="soft" disabled={loadingMore} onPress={() => void loadHistory(filter, false, activeCursor)} />
        )}
      </ScrollView>
    </Screen>
  );
}
