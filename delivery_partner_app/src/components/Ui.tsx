import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Children, type ComponentProps, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text as NativeText,
  View,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { translatePartner } from "../partnerI18n";
import { useDemo } from "../store";
import { colors, fonts } from "../theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];
export function Text({ children, style, ...props }: TextProps) {
  const language = useDemo((state) => state.language);
  return (
    <NativeText {...props} style={[styles.text, style]}>
      {Children.map(children, (child) => {
        if (typeof child !== "string") return child;
        const trimmed = child.trim();
        return trimmed
          ? child.replace(trimmed, translatePartner(trimmed, language))
          : child;
      })}
    </NativeText>
  );
}
export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}
export function Button({
  label,
  onPress,
  secondary = false,
  disabled = false,
  icon,
  style,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const language = useDemo((state) => state.language);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={translatePartner(label, language)}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.buttonOuter,
        compact && styles.compact,
        secondary && styles.outline,
        disabled && styles.disabled,
        style,
      ]}
    >
      {!secondary && (
        <LinearGradient
          colors={["#588C1C", "#315F0C"]}
          style={[StyleSheet.absoluteFill, styles.buttonGradient]}
        />
      )}
      {icon && (
        <Ionicons
          name={icon}
          size={18}
          color={secondary ? colors.greenDark : colors.inverse}
        />
      )}
      <Text
        style={[styles.buttonLabel, secondary && { color: colors.greenDark }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function IconBox({
  name,
  size = 21,
  tint = colors.greenSoft,
}: {
  name: IconName;
  size?: number;
  tint?: string;
}) {
  return (
    <View style={[styles.iconBox, { backgroundColor: tint }]}>
      <Ionicons name={name} size={size} color={colors.green} />
    </View>
  );
}
export function IconButton({
  name,
  label,
  onPress,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
}) {
  const language = useDemo((state) => state.language);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={translatePartner(label, language)}
      hitSlop={8}
      onPress={onPress}
      style={styles.iconButton}
    >
      <Ionicons name={name} size={22} color={colors.text} />
    </Pressable>
  );
}
export function PageTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.pageTitle}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}
export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}
export const styles = StyleSheet.create({
  text: { fontFamily: fonts.regular, color: colors.text, fontSize: 13 },
  card: {
    backgroundColor: colors.raised,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 18,
    padding: 15,
    marginBottom: 11,
    shadowColor: "#785A28",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.09,
    shadowRadius: 9,
    elevation: 2,
  },
  buttonOuter: {
    minHeight: 50,
    borderRadius: 14,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 14,
  },
  buttonGradient: { borderRadius: 13 },
  compact: { minHeight: 40, borderRadius: 11 },
  outline: {
    borderWidth: 1,
    borderColor: colors.green,
    backgroundColor: colors.surface,
  },
  disabled: { opacity: 0.45 },
  buttonLabel: {
    color: colors.inverse,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  iconBox: {
    width: 43,
    height: 43,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  pageTitle: {
    fontFamily: fonts.bold,
    fontSize: 25,
    lineHeight: 32,
    color: colors.text,
  },
  subtitle: {
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 19,
    marginTop: 2,
  },
  chip: {
    paddingHorizontal: 14,
    minHeight: 38,
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { fontFamily: fonts.medium, fontSize: 11 },
  chipTextActive: { color: colors.inverse },
});
