import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import { disablePushNotifications, enablePushNotifications, startPushSession, usePushStatus } from '@/src/notifications/push';
import { useCustomer } from '@/src/store/customer';
import { Card, shared } from './Shared';

export function PushCoordinator() {
  const userId = useCustomer(state => state.status === 'signedIn' ? state.profile?.userId : undefined);
  useEffect(() => {
    if (!userId) return;
    return startPushSession(userId, () => {void useCustomer.getState().loadAccount();}, () => {
      void useCustomer.getState().loadAccount();
      router.push({pathname:'/profile',params:{open:'notifications'}});
    });
  }, [userId]);
  return null;
}

export function PushSettings() {
  const userId = useCustomer(state => state.profile?.userId);
  const {status, message} = usePushStatus();
  return <Card><View style={shared.row}><Ionicons name="notifications-outline" size={21} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>Delivery alerts</AppText><AppText style={shared.muted}>{status === 'enabled' ? message || 'Alerts are on for this device.' : status === 'expo-go' ? 'Push alerts need an Android development build. Your inbox is available here.' : status === 'unsupported' ? 'Push alerts are available on Android. Your inbox is available here.' : status === 'busy' || status === 'checking' ? 'Checking this device…' : message || 'Get order updates on this device.'}</AppText></View></View>{(status === 'available' || status === 'error') && !!userId && <Button label={status === 'error' ? 'Try alerts again' : 'Enable delivery alerts'} size="sm" variant="soft" onPress={() => void enablePushNotifications(userId)} />}{status === 'enabled' && !!userId && <Button label="Turn off alerts" size="sm" variant="soft" onPress={() => void disablePushNotifications(userId)} />}</Card>;
}
