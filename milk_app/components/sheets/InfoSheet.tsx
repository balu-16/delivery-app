import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { colors, fonts, radii } from '@/constants/theme';

/** Shared editorial sheet for support, legal and account explainer content. */
export function InfoSheet({
  visible,
  onClose,
  title,
  body,
  icon = 'leaf-outline',
  footnote,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body: string;
  icon?: ComponentProps<typeof Ionicons>['name'];
  footnote?: string;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={30} color={colors.green} />
      </View>
      <AppText style={styles.body}>{body}</AppText>
      {footnote ? (
        <View style={styles.note}>
          <Ionicons name="sparkles-outline" size={15} color={colors.brown} />
          <AppText style={styles.noteText}>{footnote}</AppText>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 13.5,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 16,
    padding: 12,
    borderRadius: radii.sm,
    backgroundColor: colors.peachSoft,
  },
  noteText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 11.5,
    lineHeight: 17,
    color: colors.brown,
  },
});
