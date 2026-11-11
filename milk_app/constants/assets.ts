import type { ImageProps } from 'expo-image';

/** Asset type accepted by expo-image. `require()` returns a numeric id. */
export type AssetSource = NonNullable<ImageProps['source']>;

/**
 * Single source of truth for every image in the app.
 *
 * Artwork is kept in individual image layers so components can arrange and
 * animate the illustrations independently.
 */
export const images = {
  // Brand / layouts
  onboardingFarm: require('../assets/images/onboarding-farm.png') as AssetSource,
  onboardingFresh: require('../assets/images/onboarding-fresh.png') as AssetSource,
  onboardingDelivery: require('../assets/images/onboarding-delivery.png') as AssetSource,
  logoEmblem: require('../assets/images/logo-emblem.png') as AssetSource,
  avatarRahul: require('../assets/images/avatar-hd.png') as AssetSource,

  // Scenes
  homeHero: require('../assets/images/farm-scene-hd.png') as AssetSource,
  productHero: require('../assets/images/farm-scene-hd.png') as AssetSource,
  myDairyBanner: require('../assets/images/farm-scene-hd.png') as AssetSource,
  profileBanner: require('../assets/images/calf-farm-hd.png') as AssetSource,
  cartMilkCan: require('../assets/images/milk-can-hd.png') as AssetSource,
  footerCow: require('../assets/images/calf-hd.png') as AssetSource,

  // Mascots & decorative sprites
  cowMascot: require('../assets/images/calf-hd.png') as AssetSource,
  cowOnCart: require('../assets/images/cow-cart-hd.png') as AssetSource,
  babyCow: require('../assets/images/calf-hd.png') as AssetSource,
  navCow: require('../assets/images/calf-hd.png') as AssetSource,
  leafA: require('../assets/images/leaf-a.png') as AssetSource,
  leafB: require('../assets/images/leaf-b.png') as AssetSource,

  // Products
  bottleA2: require('../assets/images/milk-hd.png') as AssetSource,
  bottleBuffalo: require('../assets/images/milk-hd.png') as AssetSource,
  paneer: require('../assets/images/paneer-hd.png') as AssetSource,
  gheeJar: require('../assets/images/ghee-hd.png') as AssetSource,
  crateMilk: require('../assets/images/crate-hd.png') as AssetSource,

  // Category artwork
  categoryMilk: require('../assets/images/milk-hd.png') as AssetSource,
  categoryCurd: require('../assets/images/curd-hd.png') as AssetSource,
  categoryPaneer: require('../assets/images/paneer-hd.png') as AssetSource,
  categoryGhee: require('../assets/images/ghee-hd.png') as AssetSource,
  categoryButter: require('../assets/images/butter-hd.png') as AssetSource,
  categoryButtermilk: require('../assets/images/buttermilk-hd.png') as AssetSource,
  categoryLassi: require('../assets/images/lassi-hd.png') as AssetSource,
  chipMilk: require('../assets/images/milk-hd.png') as AssetSource,
  chipCurd: require('../assets/images/curd-hd.png') as AssetSource,
  chipPaneer: require('../assets/images/paneer-hd.png') as AssetSource,
  chipGhee: require('../assets/images/ghee-hd.png') as AssetSource,
  chipButter: require('../assets/images/butter-hd.png') as AssetSource,
} as const;

export type DairyImage = keyof typeof images;
