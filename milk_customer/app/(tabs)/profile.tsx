import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, formatPaise, shared } from '@/components/connected/Shared';
import { ProfileCoverEditor, profileCoverSource } from '@/components/connected/ProfileCoverEditor';
import { images } from '@/constants/assets';
import { colors, fonts, layout, shadows } from '@/constants/theme';
import { useProfileCover } from '@/hooks/useProfileCover';
import { customerApi, customerDetailsApi, type ReferralView } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { agentClient } from '@/src/agent/client';
import { agentStrings } from '@/src/agent/strings';
import { COVER_RATIO } from '@/src/profile/cover-crop';

type Sheet = 'edit' | 'settings' | 'language' | 'ai_privacy' | null;
type ProfileIcon = React.ComponentProps<typeof Ionicons>['name'];

function Row({ icon, label, onPress }: { icon: ProfileIcon; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={22} color={colors.brown} />
      <AppText allowFontScaling style={styles.rowLabel}>
        {label}
      </AppText>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </Pressable>
  );
}

function Shortcut({
  icon,
  label,
  detail,
  onPress,
}: {
  icon: ProfileIcon;
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? label + ', ' + detail : label}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={25} color={colors.brown} />
      <AppText allowFontScaling style={styles.tileLabel}>
        {label}
      </AppText>
      {detail ? (
        <AppText allowFontScaling style={styles.tileDetail}>
          {detail}
        </AppText>
      ) : null}
    </Pressable>
  );
}

export default function Profile() {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const params = useLocalSearchParams<{ open?: string }>();
  const { profile, wallet, loadWallet, logout } = useCustomer();
  const userId = profile?.userId;
  const { cover, coverFailed, refreshCover, applyCover } = useProfileCover(userId);
  const [coverEditor, setCoverEditor] = useState<string>();
  const [brokenCoverUrl, setBrokenCoverUrl] = useState<string>();
  const coverRetry = useRef<string | null>(null);
  const [details, setDetails] = useState<{ userId: string; referral?: ReferralView; unread?: number }>();
  const assistantText = agentStrings(profile?.locale);
  const [assistantPrivacyAvailable, setAssistantPrivacyAvailable] = useState(false);
  const [assistantConsent, setAssistantConsent] = useState(false);
  const [privacyNotice, setPrivacyNotice] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  // Legacy query redirects: wallet / notifications / support / referral -> destinations once.
  useEffect(() => {
    const open = typeof params.open === 'string' ? params.open : null;
    if (!open) return;
    if (open === 'notifications') {
      router.replace('/notifications');
    } else if (open === 'wallet') {
      router.replace('/wallet');
    } else if (open === 'support') {
      router.replace('/support');
    } else if (open === 'referral' || open === 'referrals') {
      router.replace('/referrals');
    } else if (open === 'addresses') {
      router.replace('/addresses');
    }
  }, [params.open]);

  const loadSummary = useCallback(
    async (signal?: AbortSignal) => {
      if (!userId) return;
      const walletRequest = loadWallet({ silent: true });
      try {
        const token = await accessToken();
        if (signal?.aborted || useCustomer.getState().profile?.userId !== userId) return;
        const [referral, unread] = await Promise.allSettled([
          customerDetailsApi.referral(token, signal),
          customerDetailsApi.unreadCount(token, signal),
        ]);
        if (!signal?.aborted && useCustomer.getState().profile?.userId === userId) {
          setDetails((current) => ({
            userId,
            referral:
              referral.status === 'fulfilled'
                ? referral.value
                : current?.userId === userId
                  ? current.referral
                  : undefined,
            unread:
              unread.status === 'fulfilled'
                ? unread.value.count
                : current?.userId === userId
                  ? current.unread
                  : undefined,
          }));
        }
      } catch {
        // Wallet and the existing routes remain available during a partial load.
      } finally {
        await walletRequest;
      }
    },
    [loadWallet, userId],
  );

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      const request = new AbortController();
      void loadSummary(request.signal);
      void agentClient
        .consentStatus()
        .then((s) => {
          if (!request.signal.aborted && useCustomer.getState().profile?.userId === userId) {
            setAssistantConsent(s.accepted);
            setAssistantPrivacyAvailable(true);
          }
        })
        .catch(() => {
          if (!request.signal.aborted) setAssistantPrivacyAvailable(false);
        });
      return () => request.abort();
    }, [loadSummary, userId]),
  );

  const { refreshing, onRefresh } = useRefresh(async () => {
    await Promise.allSettled([loadSummary(), refreshCover()]);
  });

  const showSheet = (next: Sheet) => {
    setError('');
    setSheet(next);
    if (next === 'edit') setName(profile?.name ?? '');
  };

  const saveName = async () => {
    if (!name.trim() || working) return;
    setWorking(true);
    setError('');
    try {
      const token = await accessToken();
      if (useCustomer.getState().profile?.userId !== userId) return;
      await customerDetailsApi.updateProfile(token, name.trim());
      const updated = await customerApi.profile(token);
      if (useCustomer.getState().profile?.userId !== userId) return;
      useCustomer.setState({ profile: updated });
      setSheet(null);
    } catch {
      setError('Couldn’t update your profile.');
    } finally {
      setWorking(false);
    }
  };

  const managePrivacy = () => {
    if (working) return;
    Alert.alert(assistantText.withdraw, assistantText.withdrawConfirm, [
      { text: assistantText.keep, style: 'cancel' },
      {
        text: assistantText.withdraw,
        style: 'destructive',
        onPress: () => {
          setWorking(true);
          setError('');
          setPrivacyNotice('');
          void agentClient
            .revokeConsent()
            .then(() => {
              setAssistantConsent(false);
              setPrivacyNotice(assistantText.consentWithdrawn);
            })
            .catch(() => setError(assistantText.privacyError))
            .finally(() => setWorking(false));
        },
      },
    ]);
  };

  const summary = details?.userId === userId ? details : undefined;
  const referral = summary?.referral;
  const displayName = profile?.name.trim() || 'Customer';
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join('')
    .toUpperCase();
  const balance =
    wallet && wallet.userId === userId
      ? formatPaise((BigInt(wallet.cashPaise) + BigInt(wallet.promoPaise)).toString())
      : undefined;
  const coverUrl = cover?.imageUrl ?? undefined;
  const activePhoto = cover?.kind === 'photo' && coverUrl && coverUrl !== brokenCoverUrl;
  const coverSource =
    cover?.kind === 'photo' && !activePhoto ? images.profileBanner : profileCoverSource(cover);
  const compactTiles = width < 360 || fontScale > 1.15;
  const onCoverError = () => {
    if (!coverUrl || cover?.kind !== 'photo') return;
    setBrokenCoverUrl(coverUrl);
    if (coverRetry.current === cover.mediaId) return;
    coverRetry.current = cover.mediaId ?? null;
    void refreshCover();
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 10) + layout.grassHeightAboveBottomInset + 16,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.green}
          />
        }
      >
        <View style={[styles.hero, { minHeight: insets.top + 140 }]}>
          <Image
            source={coverSource}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy={activePhoto ? 'none' : 'memory-disk'}
            recyclingKey={
              (userId ?? 'default') +
              ':' +
              (cover?.version ?? '0') +
              ':' +
              (activePhoto ? 'photo' : 'preset')
            }
            onError={activePhoto ? onCoverError : undefined}
          />
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(255,249,240,0.94)', 'rgba(255,249,240,0.45)', 'rgba(255,249,240,0)']}
            locations={[0, 0.2, 0.55]}
            style={StyleSheet.absoluteFill}
          />
          <View style={[styles.heroHeader, { paddingTop: insets.top + 8 }]}>
            <AppText allowFontScaling accessibilityRole="header" style={styles.title}>
              Profile
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Account settings"
              onPress={() => showSheet('settings')}
              style={({ pressed }) => [styles.gear, pressed && styles.pressed]}
            >
              <Ionicons name="settings-outline" size={23} color={colors.brownDark} />
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change cover"
            onPress={() => setCoverEditor(userId)}
            style={({ pressed }) => [styles.coverButton, pressed && styles.pressed]}
          >
            <Ionicons name="image-outline" size={17} color={colors.brownDark} />
            <AppText allowFontScaling style={styles.coverLabel}>
              Change cover
            </AppText>
          </Pressable>
        </View>

        <View style={styles.panel}>
          <ErrorBanner />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[
              displayName,
              profile?.email,
              profile?.emailVerified ? 'Email verified' : undefined,
              'Edit profile',
            ]
              .filter(Boolean)
              .join(', ')}
            onPress={() => showSheet('edit')}
            style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
          >
            <View style={styles.avatar}>
              <AppText style={styles.initials}>{initials}</AppText>
            </View>
            <View style={styles.identityText}>
              <AppText allowFontScaling style={styles.name}>
                {displayName}
              </AppText>
              {profile?.email ? (
                <AppText allowFontScaling style={styles.email}>
                  {profile.email}
                </AppText>
              ) : null}
              {profile?.emailVerified && (
                <View style={styles.verified}>
                  <Ionicons name="checkmark-circle" size={15} color={colors.green} />
                  <AppText allowFontScaling style={styles.verifiedLabel}>
                    Email verified
                  </AppText>
                </View>
              )}
            </View>
            <View style={styles.chevron}>
              <Ionicons name="chevron-forward" size={22} color={colors.brown} />
            </View>
          </Pressable>

          <View style={styles.shortcuts}>
            <View style={[styles.shortcutRow, !compactTiles && styles.shortcutPair]}>
              <Shortcut
                icon="home-outline"
                label="Addresses"
                onPress={() => router.push('/addresses')}
              />
              <Shortcut
                icon="wallet-outline"
                label="Wallet"
                detail={balance}
                onPress={() => router.push('/wallet')}
              />
            </View>
            <View style={[styles.shortcutRow, !compactTiles && styles.shortcutPair]}>
              <Shortcut
                icon="gift-outline"
                label="Refer & Earn"
                onPress={() => router.push('/referrals')}
              />
              <Shortcut
                icon="notifications-outline"
                label="Notifications"
                detail={summary?.unread ? String(summary.unread) + ' unread' : undefined}
                onPress={() => router.push('/notifications')}
              />
            </View>
          </View>

          {referral?.enabled && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={'Invite friends and earn ' + formatPaise(referral.rewardPaise)}
              accessibilityHint="Earn a reward when a friend signs up with your code and verifies their email"
              onPress={() => router.push('/referrals')}
              style={({ pressed }) => [styles.referral, pressed && styles.pressed]}
            >
              <Image source={images.profileBanner} style={StyleSheet.absoluteFill} contentFit="cover" />
              <View style={[styles.referralCopy, fontScale > 1.15 && styles.referralCopyWide]}>
                <AppText allowFontScaling style={styles.referralTitle}>
                  Invite friends & earn {formatPaise(referral.rewardPaise)}
                </AppText>
                <AppText allowFontScaling style={styles.referralBody}>
                  When a friend signs up with your code and verifies their email.
                </AppText>
                <View style={styles.invite}>
                  <AppText allowFontScaling style={styles.inviteLabel}>
                    Invite now
                  </AppText>
                  <Ionicons name="arrow-forward" size={15} color={colors.green} />
                </View>
              </View>
            </Pressable>
          )}

          <View style={styles.support}>
            <AppText allowFontScaling accessibilityRole="header" style={styles.sectionTitle}>
              Support & More
            </AppText>
            <View style={styles.rowGroup}>
              <Row
                icon="headset-outline"
                label="Help & Support"
                onPress={() => router.push('/support')}
              />
            </View>
          </View>
        </View>
      </ScrollView>

      <BottomSheet
        visible={!!sheet}
        onClose={() => setSheet(null)}
        title={
          sheet === 'edit'
            ? 'Edit profile'
            : sheet === 'settings'
              ? 'Account settings'
              : sheet === 'language'
                ? 'Language'
                : assistantText.privacy
        }
        keyboardAware={sheet === 'edit'}
      >
        <View style={{ gap: 12 }}>
          <ErrorBanner />
          {!!error && <AppText style={{ color: colors.danger }}>{error}</AppText>}
          {sheet === 'edit' && (
            <>
              <TextInput
                style={shared.input}
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                maxLength={100}
                accessibilityLabel="Your name"
              />
              <Button
                label="Save"
                fullWidth
                onPress={() => void saveName()}
                loading={working}
                disabled={!name.trim()}
              />
            </>
          )}
          {sheet === 'language' && (
            <>
              <Button label="English" fullWidth onPress={() => setSheet(null)} />
            </>
          )}
          {sheet === 'settings' && (
            <>
              <Row icon="language-outline" label="Language" onPress={() => showSheet('language')} />
              {assistantPrivacyAvailable && (
                <Row
                  icon="shield-checkmark-outline"
                  label={assistantText.privacy}
                  onPress={() => showSheet('ai_privacy')}
                />
              )}
              <Row
                icon="log-out-outline"
                label="Sign out"
                onPress={() => {
                  setSheet(null);
                  void logout();
                }}
              />
            </>
          )}
          {sheet === 'ai_privacy' && (
            <>
              <AppText style={shared.body}>{assistantText.privacyBody}</AppText>
              <AppText style={shared.muted}>
                {assistantConsent ? assistantText.consentOn : assistantText.consentOff}
              </AppText>
              {!!privacyNotice && (
                <AppText accessibilityLiveRegion="polite" style={shared.body}>
                  {privacyNotice}
                </AppText>
              )}
              {assistantConsent && (
                <Button
                  label={assistantText.withdraw}
                  fullWidth
                  variant="outline"
                  disabled={working}
                  onPress={managePrivacy}
                />
              )}
            </>
          )}
        </View>
      </BottomSheet>
      {userId && coverEditor === userId && (
        <ProfileCoverEditor
          key={userId}
          userId={userId}
          cover={cover}
          coverFailed={coverFailed}
          onRefresh={refreshCover}
          onSave={(saved) => {
            applyCover(saved);
            setBrokenCoverUrl(undefined);
            coverRetry.current = null;
            setCoverEditor(undefined);
          }}
          onClose={() => setCoverEditor(undefined)}
        />
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  hero: {
    width: '100%',
    maxWidth: 600,
    aspectRatio: COVER_RATIO,
    alignSelf: 'center',
    backgroundColor: colors.cream,
    justifyContent: 'space-between',
  },
  heroHeader: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { fontFamily: fonts.bold, fontSize: 27, color: colors.brownDark },
  gear: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 7,
    marginBottom: 20,
    marginHorizontal: 16,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: colors.surfaceRaised,
  },
  coverLabel: { fontFamily: fonts.semibold, fontSize: 12, color: colors.brownDark },
  panel: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 600,
    marginTop: -10,
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    backgroundColor: colors.background,
    paddingHorizontal: 16,
    paddingTop: 21,
    gap: 15,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 3, minHeight: 76 },
  avatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    borderColor: colors.surfaceRaised,
    borderWidth: 2,
    backgroundColor: colors.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: { fontFamily: fonts.semibold, color: colors.green, fontSize: 21 },
  identityText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.bold, fontSize: 20, color: colors.text },
  email: { fontSize: 12, color: colors.textSecondary },
  verified: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  verifiedLabel: { color: colors.green, fontFamily: fonts.medium, fontSize: 11, flexShrink: 1 },
  chevron: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.tiny,
  },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shortcutRow: { flexDirection: 'row', alignItems: 'stretch', width: '100%', gap: 8 },
  shortcutPair: { flex: 1, width: 'auto' },
  tile: {
    flex: 1,
    minHeight: 77,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 15,
    backgroundColor: colors.surfaceRaised,
    ...shadows.tiny,
  },
  tileLabel: { fontSize: 10, textAlign: 'center', fontFamily: fonts.medium, color: colors.text },
  tileDetail: { fontSize: 10, textAlign: 'center', fontFamily: fonts.semibold, color: colors.green },
  referral: {
    minHeight: 131,
    justifyContent: 'center',
    padding: 10,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: colors.cream,
  },
  referralCopy: {
    alignSelf: 'flex-start',
    width: '59%',
    padding: 10,
    borderRadius: 14,
    gap: 4,
    backgroundColor: 'rgba(255,249,239,0.94)',
  },
  referralCopyWide: { width: '78%' },
  referralTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  referralBody: { fontSize: 11, color: colors.text },
  invite: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  inviteLabel: { fontFamily: fonts.semibold, color: colors.green, fontSize: 12, flexShrink: 1 },
  support: { gap: 9 },
  sectionTitle: { fontFamily: fonts.semibold, fontSize: 17, color: colors.text },
  rowGroup: { borderWidth: 1, borderColor: colors.line, borderRadius: 17, overflow: 'hidden' },
  row: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: colors.surfaceRaised,
  },
  rowLabel: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  pressed: { opacity: 0.74 },
});
