import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/AppText';
import { colors, shadows } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';
import { selectionFeedback } from '@/utils/haptics';

export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  scroll = true,
  maxHeight = '86%',
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
  maxHeight?: `${number}%`;
}) {
  const enabled = useMotionEnabled();
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(520);
  const backdrop = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.set(enabled ? withSpring(0, { damping: 22, stiffness: 220, mass: 0.8 }) : 0);
      backdrop.set(withTiming(1, { duration: 220 }));
    } else {
      translateY.set(520);
      backdrop.set(0);
    }
  }, [backdrop, enabled, translateY, visible]);

  const close = () => {
    selectionFeedback();
    translateY.set(withTiming(560, { duration: 220 }, () => {}));
    backdrop.set(withTiming(0, { duration: 200 }));
    setTimeout(onClose, 120);
  };

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .onUpdate((event) => {
      if (event.translationY > 0) translateY.set(event.translationY);
    })
    .onEnd((event) => {
      if (event.translationY > 110 || event.velocityY > 700) {
        translateY.set(withTiming(560, { duration: 220 }));
        backdrop.set(withTiming(0, { duration: 160 }));
        setTimeout(onClose, 100);
      } else {
        translateY.set(withSpring(0, { damping: 22, stiffness: 220 }));
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value * 0.42 }));

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={close}
    >
      <View style={styles.modal}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.sheet,
              { maxHeight, paddingBottom: Math.max(insets.bottom, 18) },
              sheetStyle,
            ]}
          >
            <View style={styles.handleWrap}>
              <View style={styles.handle} />
            </View>
            {title ? (
              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <AppText style={styles.title}>{title}</AppText>
                  {subtitle ? <AppText style={styles.subtitle}>{subtitle}</AppText> : null}
                </View>
                <Pressable onPress={close} hitSlop={10} style={styles.close} accessibilityLabel="Close sheet">
                  <Ionicons name="close" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            ) : null}
            {scroll ? (
              <ScrollView
                showsVerticalScrollIndicator={false}
                bounces={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 6 }}
              >
                {children}
              </ScrollView>
            ) : (
              <View>{children}</View>
            )}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#2B2118',
  },
  sheet: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    ...shadows.tab,
  },
  handleWrap: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  handle: {
    width: 42,
    height: 4.5,
    borderRadius: 3,
    backgroundColor: colors.lineStrong,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 8,
    paddingBottom: 16,
  },
  title: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 19,
    lineHeight: 26,
    color: colors.text,
  },
  subtitle: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    marginTop: 2,
    paddingRight: 14,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
