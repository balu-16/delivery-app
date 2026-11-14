import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ApiError, riderApi, type Application } from '../api';
import { getAccessToken, type PartnerIdentity } from '../auth/session';
import { Brand } from '../components/Brand';
import { Button, Text } from '../components/Ui';
import { stopTracking } from '../tracking';
import { colors } from '../theme';
import { ApplicationScreen } from './ApplicationScreen';
import { LivePartner } from './LivePartner';

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function PartnerApp({ identity, onSignOut }: { identity: PartnerIdentity; onSignOut: () => Promise<void> }) {
  const [application, setApplication] = useState<Application | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      setWaiting(true); setError('');
      try {
        let ready = false;
        for (let attempt = 0; attempt < 15 && active; attempt++) {
          // The ID token used by bootstrap must eventually reflect a newly
          // assigned Cognito group; the access-token refresh updates both.
          if (attempt > 0 && attempt % 3 === 0) await getAccessToken(true);
          const bootstrap = await riderApi.bootstrap();
          if (!bootstrap.groupPending) {
            await getAccessToken(true);
            try {
              const next = await riderApi.application();
              if (active) setApplication(next);
              ready = true;
              break;
            } catch (failure) {
              if (!(failure instanceof ApiError && failure.status === 403)) throw failure;
            }
          }
          await delay(2000);
        }
        if (active && !ready) throw new Error('Your application is still being prepared. Please try again shortly.');
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not load your application.');
      } finally { if (active) setWaiting(false); }
    };
    void initialize();
    return () => { active = false; };
  }, [identity.subject, retry]);

  const reload = useCallback(async () => { setApplication(await riderApi.application()); }, []);
  useEffect(() => {
    if (application?.status !== 'UNDER_REVIEW') return;
    const timer = setInterval(() => { void reload().catch(() => undefined); }, 20000);
    return () => clearInterval(timer);
  }, [application?.status, reload]);

  if (application?.status === 'APPROVED') return <LivePartner identity={identity} application={application} onSignOut={onSignOut} onAuthorizationChange={reload} />;
  if (application) return <ApplicationScreen application={application} reload={reload} signOut={async () => { await stopTracking(); await onSignOut(); }} />;
  return <View style={styles.center}><Brand large />
    {waiting ? <><ActivityIndicator color={colors.green} style={{ marginTop: 20 }} /><Text style={styles.message}>Preparing your partner application…</Text></>
      : <><Text accessibilityRole="alert" style={styles.message}>{error}</Text><View style={{ width: '100%', gap: 10 }}>
        <Button label="Try again" onPress={() => setRetry((value) => value + 1)} />
        <Button label="Sign out" secondary onPress={() => void onSignOut()} />
      </View></>}
  </View>;
}
const styles = StyleSheet.create({ center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', padding: 28 },
  message: { textAlign: 'center', color: colors.secondary, marginVertical: 16, lineHeight: 21 } });
