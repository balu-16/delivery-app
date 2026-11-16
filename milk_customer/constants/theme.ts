import { Platform, TextStyle, ViewStyle } from 'react-native';

/**
 * DairyDirect design tokens.
 *
 * Values were sampled from the provided 6-screen reference sheet and then
 * normalised for a 390pt-wide handset. Everything visual in the app should be
 * sourced from this file so the UI stays consistent.
 */
export const colors = {
  // Surfaces
  background: '#FBF3E7',
  backgroundTop: '#FFF9F0',
  backgroundDeep: '#F7EBDC',
  surface: '#FFF9EF',
  surfaceRaised: '#FFFCF6',
  surfaceStrong: '#FFFDF9',
  surfaceMuted: '#FBF4E8',

  // Brand greens
  green: '#3D6D15',
  greenDark: '#2E560F',
  greenDeep: '#24450C',
  greenMid: '#4F8121',
  greenLight: '#6A9A39',
  greenTint: '#DDEBC8',
  greenSoft: '#EAF2DD',
  greenPale: '#F2F6E8',
  greenIce: '#F6F9EF',

  // Accent / earth tones
  brown: '#7A4A24',
  brownDark: '#4A2F1B',
  brownMid: '#9A6B3D',
  brownLight: '#C99C6B',
  cream: '#F7E9D3',
  peach: '#F8D9B1',
  peachSoft: '#FBEBD8',
  peachDeep: '#F2C99B',

  // Type
  text: '#2F2419',
  textSecondary: '#73604A',
  muted: '#98866F',
  mutedLight: '#B6A690',
  inverse: '#FFFDF8',

  // UI
  line: '#EFE1CD',
  lineStrong: '#E4D3BC',
  white: '#FFFFFF',
  star: '#F2A722',
  danger: '#BF4B36',
  dangerSoft: '#FBE7E2',
  overlay: 'rgba(43, 33, 24, 0.38)',
  shadow: 'rgba(120, 90, 40, 0.16)',
  shadowStrong: 'rgba(84, 60, 25, 0.22)',
  tabIndicator: '#ECF2DE',
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  xxxl: 24,
  huge: 32,
} as const;

export const radii = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 28,
  pill: 999,
} as const;

export const fonts = {
  regular: 'Poppins_400Regular',
  medium: 'Poppins_500Medium',
  semibold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
  extrabold: 'Poppins_800ExtraBold',
} as const;

export const fontSizes = {
  micro: 9.5,
  caption: 11,
  small: 12,
  body: 13.5,
  bodyLarge: 15,
  title: 17,
  h3: 19,
  h2: 23,
  h1: 27,
  display: 32,
} as const;

export const lineHeights = {
  micro: 13,
  caption: 15,
  small: 17,
  body: 20,
  bodyLarge: 22,
  title: 24,
  h3: 26,
  h2: 30,
  h1: 34,
  display: 38,
} as const;

export const weights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
} as const;

export const shadows = {
  card: {
    shadowColor: '#785A28',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 5,
  } as ViewStyle,
  soft: {
    shadowColor: '#785A28',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 3,
  } as ViewStyle,
  tiny: {
    shadowColor: '#785A28',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  } as ViewStyle,
  tab: {
    shadowColor: '#6B4C1B',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 18,
  } as ViewStyle,
  float: {
    shadowColor: '#5E451E',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 12,
  } as ViewStyle,
  button: {
    shadowColor: '#2E560F',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  } as ViewStyle,
  nav: {
    shadowColor: '#4B3515',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 9,
  } as ViewStyle,
} as const;

export const gradients = {
  screen: ['#FFF9F0', '#FBF3E7'] as const,
  splash: ['#FDF7EB', '#FBF2E4'] as const,
  button: ['#4A7D1B', '#325E10'] as const,
  buttonBrown: ['#8B5A2E', '#6C3F1D'] as const,
  buttonSoft: ['#F3F8E7', '#E6F0D4'] as const,
  offer: ['#FBE6CC', '#F7D6B0'] as const,
  membership: ['#F4F7E9', '#E8F0D7'] as const,
  greenWash: ['rgba(61,109,21,0.12)', 'rgba(61,109,21,0)'] as const,
  tab: ['#FEFAF2', '#FAF0E1'] as const,
  peachWash: ['#FFF4E4', '#FCE7D0'] as const,
} as const;

export const typography = {
  display: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.display,
    lineHeight: lineHeights.display,
    letterSpacing: -0.6,
    color: colors.text,
  } as TextStyle,
  h1: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.h1,
    lineHeight: lineHeights.h1,
    letterSpacing: -0.4,
    color: colors.text,
  } as TextStyle,
  h2: {
    fontFamily: fonts.semibold,
    fontSize: fontSizes.h2,
    lineHeight: lineHeights.h2,
    letterSpacing: -0.25,
    color: colors.text,
  } as TextStyle,
  h3: {
    fontFamily: fonts.semibold,
    fontSize: fontSizes.h3,
    lineHeight: lineHeights.h3,
    letterSpacing: -0.15,
    color: colors.text,
  } as TextStyle,
  title: {
    fontFamily: fonts.semibold,
    fontSize: fontSizes.title,
    lineHeight: lineHeights.title,
    color: colors.text,
  } as TextStyle,
  body: {
    fontFamily: fonts.regular,
    fontSize: fontSizes.body,
    lineHeight: lineHeights.body,
    color: colors.text,
  } as TextStyle,
  bodyMedium: {
    fontFamily: fonts.medium,
    fontSize: fontSizes.body,
    lineHeight: lineHeights.body,
    color: colors.text,
  } as TextStyle,
  small: {
    fontFamily: fonts.regular,
    fontSize: fontSizes.small,
    lineHeight: lineHeights.small,
    color: colors.textSecondary,
  } as TextStyle,
  caption: {
    fontFamily: fonts.regular,
    fontSize: fontSizes.caption,
    lineHeight: lineHeights.caption,
    color: colors.muted,
  } as TextStyle,
  label: {
    fontFamily: fonts.medium,
    fontSize: fontSizes.small,
    lineHeight: lineHeights.small,
    color: colors.textSecondary,
  } as TextStyle,
  button: {
    fontFamily: fonts.semibold,
    fontSize: fontSizes.bodyLarge,
    lineHeight: 20,
    color: colors.inverse,
    letterSpacing: 0.1,
  } as TextStyle,
} as const;

export const layout = {
  screenPadding: 16,
  maxContentWidth: 520,
  tabBarHeight: 66,
  tabBarMargin: 14,
  grassHeightAboveBottomInset: 116,
  headerHeight: 52,
  primaryButtonHeight: 52,
} as const;

export const isIOS = Platform.OS === 'ios';
export const isWeb = Platform.OS === 'web';
