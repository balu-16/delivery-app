import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { images } from '@/constants/assets';
import { colors, fonts } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';

const ONBOARDING_KEY = '@dairydirect/onboarding-complete-v1';
const pages = [
  { key: 'farms', image: images.onboardingFarm, title: 'From our farms to your home', description: 'Fresh dairy from happy farms, delivered with care.' },
  { key: 'fresh', image: images.onboardingFresh, title: 'A little goodness in every day', description: 'Discover milk, curd, paneer and more for your family.' },
  { key: 'delivery', image: images.onboardingDelivery, title: 'Your daily dairy, made simple', description: 'Explore your favourites and make every morning brighter.' },
];

export default function OnboardingScreen() {
  const [ready, setReady] = useState(false);
  const [index, setIndex] = useState(0);
  const list = useRef<FlatList<(typeof pages)[number]>>(null);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const motion = useMotionEnabled();

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(ONBOARDING_KEY).then((value) => {
      if (!active) return;
      if (value === 'true') router.replace('/home');
      else setReady(true);
    }).catch(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  const finish = () => {
    void AsyncStorage.setItem(ONBOARDING_KEY, 'true').catch(() => {});
    router.replace('/home');
  };
  const goTo = (next: number) => {
    list.current?.scrollToOffset({ offset: next * width, animated: motion });
    setIndex(next);
  };
  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.max(0, Math.min(pages.length - 1, Math.round(event.nativeEvent.contentOffset.x / width))));
  };

  if (!ready) return <View style={styles.root} />;
  return (
    <View style={styles.root}>
      <FlatList
        ref={list} data={pages} horizontal pagingEnabled bounces={false}
        showsHorizontalScrollIndicator={false} keyExtractor={(item) => item.key}
        onMomentumScrollEnd={onScrollEnd} onScrollEndDrag={onScrollEnd}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item }) => (
          <View style={[styles.page, { width, height, paddingTop: insets.top + 14, paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.brand}><Image source={images.logoEmblem} style={styles.logo} contentFit="contain" /><AppText style={styles.brandText}>DairyDirect</AppText><AppText style={styles.tagline}>Farm Fresh. Delivered Daily.</AppText></View>
            <View style={[styles.art, { height: Math.max(150, Math.min(height * 0.43, height - 370)) }]}><Image source={item.image} style={StyleSheet.absoluteFill} contentFit="cover" /></View>
            <View style={styles.copy}><AppText style={styles.title}>{item.title}</AppText><AppText style={styles.description}>{item.description}</AppText></View>
          </View>
        )}
      />
      <View style={[styles.controls, { bottom: Math.max(insets.bottom, 12) + 14 }]}>
        <View style={styles.dots} accessibilityLabel={`Page ${index + 1} of 3`}>
          {pages.map((page, i) => <PressableScale key={page.key} onPress={() => goTo(i)} accessibilityRole="button" accessibilityLabel={`Go to page ${i + 1}`} style={[styles.dot, i === index && styles.activeDot]}><View /></PressableScale>)}
        </View>
        <PressableScale onPress={() => index === 2 ? finish() : goTo(index + 1)} accessibilityRole="button" accessibilityLabel={index === 2 ? 'Get Started' : 'Next'} style={styles.button}>
          <LinearGradient colors={['#4A7D1B', '#325E10']} style={styles.buttonFill}><AppText style={styles.buttonText}>{index === 2 ? 'Get Started' : 'Next'}</AppText><Ionicons name="arrow-forward" size={20} color={colors.inverse} /></LinearGradient>
        </PressableScale>
        {index < 2 ? <PressableScale onPress={finish} accessibilityRole="button" accessibilityLabel="Skip onboarding" style={styles.skip}><AppText style={styles.skipText}>Skip</AppText></PressableScale> : <View style={styles.skip} />}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  page: { flex: 1, alignItems: 'center', paddingHorizontal: 22, paddingBottom: 160 },
  brand: { alignItems: 'center', marginBottom: 10 },
  logo: { width: 60, height: 52 },
  brandText: { fontFamily: fonts.bold, fontSize: 25, lineHeight: 32, color: colors.brownDark },
  tagline: { fontFamily: fonts.medium, fontSize: 11, color: colors.green },
  art: { width: '100%', borderRadius: 28, overflow: 'hidden', backgroundColor: colors.greenSoft },
  copy: { alignItems: 'center', paddingHorizontal: 12, paddingTop: 18, paddingBottom: 8 },
  title: { textAlign: 'center', fontFamily: fonts.bold, fontSize: 22, lineHeight: 30, color: colors.brownDark },
  description: { textAlign: 'center', fontSize: 13, lineHeight: 20, color: colors.textSecondary, marginTop: 6 },
  controls: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 18 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.lineStrong },
  activeDot: { width: 22, backgroundColor: colors.green },
  button: { width: '100%', maxWidth: 340, borderRadius: 30, overflow: 'hidden' },
  buttonFill: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 },
  buttonText: { fontFamily: fonts.semibold, color: colors.inverse, fontSize: 15 },
  skip: { height: 36, justifyContent: 'center', paddingHorizontal: 24 },
  skipText: { color: colors.textSecondary, fontFamily: fonts.medium, fontSize: 12 },
});
