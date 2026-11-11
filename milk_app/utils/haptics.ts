import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { useUserStore } from '@/store/userStore';

const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

export function tapFeedback() {
  if (!enabled || !useUserStore.getState().hapticsOn) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function selectionFeedback() {
  if (!enabled || !useUserStore.getState().hapticsOn) return;
  Haptics.selectionAsync().catch(() => {});
}

export function successFeedback() {
  if (!enabled || !useUserStore.getState().hapticsOn) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

export function warningFeedback() {
  if (!enabled || !useUserStore.getState().hapticsOn) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}
