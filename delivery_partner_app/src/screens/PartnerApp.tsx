import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { ApiError, riderApi, type Application } from '../api';
import { getAccessToken, type PartnerIdentity } from '../auth/session';
import { Brand } from '../components/Brand';
import { FormSkeleton } from '../components/Skeleton';
import { Button, Text } from '../components/Ui';
import { clearAccountTransfers, pruneUploadCache, restoreDocumentUploads } from '../files';
import { stopTracking } from '../tracking';
import { colors } from '../theme';
import { ApplicationScreen } from './ApplicationScreen';
import { LivePartner } from './LivePartner';

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type PartnerProps = { identity: PartnerIdentity; onSignOut: () => Promise<void> };
const enrollmentNeeded = (error: unknown) => error instanceof ApiError
  && ['PROFILE_NOT_INITIALIZED', 'RIDER_APPLICATION_NOT_FOUND', 'FORBIDDEN'].includes(error.code);

export function PartnerApp(props: PartnerProps) {
  return <PartnerSession key={props.identity.subject} {...props} />;
}

function PartnerSession({ identity, onSignOut }: PartnerProps) {
  const [application, setApplication] = useState<Application | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState('');
  const [supportReference, setSupportReference] = useState<string>();
  const [retry, setRetry] = useState(0);
  const currentRead = useRef(0);
  const enrollment = useRef<AbortController | null>(null);

  useEffect(() => {
    void pruneUploadCache().catch(() => undefined);
    void restoreDocumentUploads(identity.subject);
  }, [identity.subject]);

  const acceptApplication = useCallback((next: Application) => {
    currentRead.current += 1;
    setApplication(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    enrollment.current = controller;
    const { signal } = controller;
    const notice = 'Your application is still being prepared. Please try again shortly.';
    const timer = setTimeout(() => {
      controller.abort();
      setError(notice);
      setWaiting(false);
    }, 30_000);
    const initialize = async () => {
      setWaiting(true);
      setError('');
      setSupportReference(undefined);
      try {
        try {
          const next = await riderApi.application({ signal });
          if (!signal.aborted) acceptApplication(next);
          return;
        } catch (failure) {
          if (!enrollmentNeeded(failure)) throw failure;
        }
        let refreshBeforeBootstrap = false;
        for (let attempt = 0; !signal.aborted; attempt++) {
          if (refreshBeforeBootstrap || (attempt > 0 && attempt % 3 === 0)) await getAccessToken(true);
          refreshBeforeBootstrap = false;
          if (signal.aborted) return;
          const bootstrap = await riderApi.bootstrap({ signal });
          if (!bootstrap.groupPending) {
            if (signal.aborted) return;
            try {
              const next = await riderApi.application({ signal });
              if (!signal.aborted) acceptApplication(next);
              return;
            } catch (failure) {
              if (!enrollmentNeeded(failure)) throw failure;
              refreshBeforeBootstrap = true;
            }
          }
          await delay(2000);
        }
      } catch (failure) {
        if (!signal.aborted) {
          setError(failure instanceof Error ? failure.message : 'Could not load your application.');
          if (failure instanceof ApiError && failure.code === 'RIDER_ENROLLMENT_REQUIRES_REVIEW')
            setSupportReference(failure.traceId ?? failure.requestId);
        }
      } finally {
        clearTimeout(timer);
        if (!signal.aborted) setWaiting(false);
      }
    };
    void initialize();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [acceptApplication, retry]);

  const reload = useCallback(async () => {
    const version = ++currentRead.current;
    const next = await riderApi.application();
    if (version === currentRead.current) acceptApplication(next);
  }, [acceptApplication]);
  useEffect(() => {
    if (application?.status !== 'UNDER_REVIEW') return;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void reload().catch(() => undefined).finally(() => { refreshing = false; });
    };
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh();
    }, 20000);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => { clearInterval(timer); appState.remove(); };
  }, [application?.status, reload]);

  const endSession = useCallback(async () => {
    enrollment.current?.abort();
    currentRead.current += 1;
    await clearAccountTransfers(identity.subject);
    await onSignOut();
  }, [identity.subject, onSignOut]);

  if (application?.status === 'APPROVED') return <LivePartner identity={identity} application={application} onSignOut={endSession} onAuthorizationChange={reload} />;
  if (application) return <ApplicationScreen application={application} onApplicationChange={acceptApplication}
    accountId={identity.subject} signOut={async () => { await stopTracking(); await endSession(); }} />;
  return <View style={styles.center}><Brand large />
    {waiting ? <><Text style={styles.message}>Preparing your partner application…</Text><FormSkeleton label="Loading partner application" />
      <View style={{ width: '100%', gap: 10 }}><Button label="Sign out" secondary onPress={() => void endSession()} /></View></>
      : <><Text accessibilityRole="alert" style={styles.message}>{error}</Text>
      {supportReference ? <Text selectable style={styles.reference}>Support reference {supportReference}</Text> : null}
      <View style={{ width: '100%', gap: 10 }}>
        <Button label="Try again" onPress={() => setRetry((value) => value + 1)} />
        <Button label="Sign out" secondary onPress={() => void endSession()} />
      </View></>}
  </View>;
}
const styles = StyleSheet.create({ center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', padding: 28 },
  message: { textAlign: 'center', color: colors.secondary, marginVertical: 16, lineHeight: 21 },
  reference: { textAlign: 'center', color: colors.secondary, marginBottom: 16 } });
