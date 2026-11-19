import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import { disablePushNotifications, enablePushNotifications, startPushSession, usePushStatus } from '@/src/notifications/push';
import { useCustomer } from '@/src/store/customer';
import { customerDetailsApi } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { assistantNotificationTarget } from '@/src/agent/notification-target';
import { Card, shared } from './Shared';

export function PushCoordinator() {
  const userId = useCustomer(state => state.status === 'signedIn' ? state.profile?.userId : undefined);
  useEffect(() => {
    if (!userId) return;
    return startPushSession(userId, () => {void useCustomer.getState().loadAccount();}, (data) => {
      void useCustomer.getState().loadAccount();
      const target = assistantNotificationTarget(data);
      if (target) {
        if (target.nudgeName && typeof data.notificationId === 'string' && /^[\da-f-]{36}$/i.test(data.notificationId)) {
          void accessToken().then(token => customerDetailsApi.readNotification(token, data.notificationId as string)).then(() => useCustomer.getState().loadAccount()).catch(() => undefined);
        }
        router.push({ pathname: '/agent', params: target } as Href);
        return;
      }
      router.push({pathname:'/profile',params:{open:'notifications'}});
    });
  }, [userId]);
  return null;
}

export function PushSettings() {
  const userId = useCustomer(state => state.profile?.userId);
  const {status, message} = usePushStatus();
  const [assistantAlerts, setAssistantAlerts] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  useEffect(() => {
    let active = true;
    if (userId) void accessToken().then(token => customerDetailsApi.notificationPreferences(token)).then(preferences => {
      if (active) setAssistantAlerts(preferences.find(item => item.category === 'ASSISTANT_UPDATES')?.enabled ?? true);
    }).catch(() => { if (active) setPreferenceError('Couldn’t load assistant alert settings.'); });
    return () => { active = false; };
  }, [userId]);
  const toggleAssistant = async () => {
    if (assistantAlerts === null || saving) return;
    setSaving(true); setPreferenceError('');
    try {
      const preferences = await customerDetailsApi.setAssistantNotifications(await accessToken(), !assistantAlerts);
      setAssistantAlerts(preferences.find(item => item.category === 'ASSISTANT_UPDATES')?.enabled ?? !assistantAlerts);
    } catch { setPreferenceError('Couldn’t update assistant alerts.'); }
    finally { setSaving(false); }
  };
  return <Card><View style={shared.row}><Ionicons name="notifications-outline" size={21} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>Delivery alerts</AppText><AppText style={shared.muted}>{status === 'enabled' ? message || 'Alerts are on for this device.' : status === 'expo-go' ? 'Push alerts need an Android development build. Your inbox is available here.' : status === 'unsupported' ? 'Push alerts are available on Android. Your inbox is available here.' : status === 'busy' || status === 'checking' ? 'Checking this device…' : message || 'Get order updates on this device.'}</AppText></View></View>{(status === 'available' || status === 'error') && !!userId && <Button label={status === 'error' ? 'Try alerts again' : 'Enable delivery alerts'} size="sm" variant="soft" onPress={() => void enablePushNotifications(userId)} />}{status === 'enabled' && !!userId && <Button label="Turn off alerts" size="sm" variant="soft" onPress={() => void disablePushNotifications(userId)} />}{assistantAlerts !== null && <Button label={assistantAlerts ? 'Turn off assistant alerts' : 'Turn on assistant alerts'} size="sm" variant="soft" disabled={saving} onPress={() => void toggleAssistant()} />}{!!preferenceError && <AppText style={shared.muted}>{preferenceError}</AppText>}</Card>;
}
