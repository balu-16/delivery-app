import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { colors, fonts, radii } from '@/constants/theme';
import { notifications } from '@/data/profile';
import { useUserStore } from '@/store/userStore';

export function NotificationsSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const markRead = useUserStore((state) => state.markNotificationsRead);

  useEffect(() => {
    if (visible) markRead();
  }, [markRead, visible]);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Notifications"
      subtitle="Fresh updates from your farm and delivery partner."
    >
      <View style={styles.list}>
        {notifications.map((item) => (
          <View
            key={item.id}
            style={[
              styles.card,
              item.tint === 'peach' ? styles.cardPeach : styles.cardGreen,
            ]}
          >
            <View
              style={[
                styles.icon,
                item.tint === 'peach' ? styles.iconPeach : styles.iconGreen,
              ]}
            >
              <Ionicons
                name={item.tint === 'peach' ? 'receipt-outline' : 'bicycle-outline'}
                size={18}
                color={item.tint === 'peach' ? colors.brown : colors.green}
              />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.titleRow}>
                <AppText style={styles.title}>{item.title}</AppText>
                <AppText style={styles.time}>{item.time}</AppText>
              </View>
              <AppText style={styles.body}>{item.body}</AppText>
            </View>
          </View>
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 10,
  },
  card: {
    flexDirection: 'row',
    gap: 11,
    borderRadius: radii.md,
    padding: 12,
    borderWidth: 1,
  },
  cardGreen: {
    backgroundColor: colors.greenIce,
    borderColor: 'rgba(61,109,21,0.12)',
  },
  cardPeach: {
    backgroundColor: colors.peachSoft,
    borderColor: 'rgba(194,143,80,0.15)',
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGreen: {
    backgroundColor: colors.white,
  },
  iconPeach: {
    backgroundColor: colors.surface,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  title: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text,
  },
  time: {
    fontFamily: fonts.regular,
    fontSize: 9.5,
    lineHeight: 13,
    color: colors.muted,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
