import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { colors } from '@/constants/theme';

type Tone = 'green' | 'soft' | 'peach' | 'outline' | 'danger';

export function Badge({
  children,
  tone = 'green',
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  style?: object;
}) {
  return (
    <View style={[styles.base, tones[tone], style]}>
      <AppText style={[styles.text, textTones[tone]]}>{children}</AppText>
    </View>
  );
}

const tones = StyleSheet.create({
  green: { backgroundColor: colors.green },
  soft: { backgroundColor: colors.greenTint },
  peach: { backgroundColor: colors.peachSoft },
  outline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.lineStrong },
  danger: { backgroundColor: colors.dangerSoft },
});

const textTones = StyleSheet.create({
  green: { color: colors.inverse },
  soft: { color: colors.greenDark },
  peach: { color: colors.brown },
  outline: { color: colors.brown },
  danger: { color: colors.danger },
});

const styles = StyleSheet.create({
  base: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  text: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 9.5,
    lineHeight: 13,
    letterSpacing: 0.3,
    color: colors.inverse,
  },
});
