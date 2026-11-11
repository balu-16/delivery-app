import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { FarmPromo } from '@/components/home/FarmPromo';
import { AppText } from '@/components/ui/AppText';
import { colors, fonts, shadows } from '@/constants/theme';
import { homeCategories, type HomeCategory } from '@/data/products';

export function HomeCategories({
  width,
  onSelect,
}: {
  width: number;
  onSelect: (category: HomeCategory) => void;
}) {
  const cardPadding = 10;
  const cellWidth = (width - cardPadding * 2) / 5;
  const firstRow = homeCategories.slice(0, 5);
  const secondRow = homeCategories.slice(5);

  return (
    <View style={styles.root}>
      <View style={styles.cardBg} />
      <View style={styles.grid}>
        <View style={styles.row}>
          {firstRow.map((category) => (
            <CategoryCell
              key={category.key}
              category={category}
              width={cellWidth}
              onPress={() => onSelect(category)}
            />
          ))}
        </View>
        <View style={styles.row}>
          {secondRow.map((category) => (
            <CategoryCell
              key={category.key}
              category={category}
              width={cellWidth}
              onPress={() => onSelect(category)}
            />
          ))}
          <View style={{ width: cellWidth }} />
          <View style={{ width: cellWidth }} />
        </View>
      </View>
      <View style={styles.farm}>
        <FarmPromo width={Math.min(158, cellWidth * 2.35)} onPress={() => onSelect({ key: 'all', label: 'View All' })} />
      </View>
    </View>
  );
}

function CategoryCell({
  category,
  width,
  onPress,
}: {
  category: HomeCategory;
  width: number;
  onPress: () => void;
}) {
  if (category.key === 'all') {
    return (
      <PressableScale
        onPress={onPress}
        haptic="select"
        style={[styles.cell, { width }]}
        accessibilityLabel="View all products"
      >
        <View style={styles.viewAllTile}>
          <Ionicons name="grid" size={25} color={colors.green} />
          <AppText style={styles.viewAllLabel}>{category.label}</AppText>
        </View>
      </PressableScale>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      haptic="select"
      style={[styles.cell, { width }]}
      accessibilityLabel={category.label}
    >
      <View style={styles.cellDisc}>
        <Image source={category.image} style={styles.cellImage} contentFit="contain" />
      </View>
      <AppText style={styles.cellLabel} numberOfLines={1}>
        {category.label}
      </AppText>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    marginTop: 14,
    paddingTop: 10,
    paddingBottom: 7,
    paddingHorizontal: 10,
    ...shadows.soft,
  },
  cardBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
  },
  grid: {
    zIndex: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cell: {
    alignItems: 'center',
    paddingVertical: 4,
    minHeight: 81,
  },
  cellDisc: {
    width: 58,
    height: 58,
    borderRadius: 29,
    overflow: 'hidden',
    backgroundColor: '#FCF5EC',
    marginTop: -1,
  },
  cellImage: {
    width: '100%',
    height: '100%',
  },
  cellLabel: {
    fontFamily: fonts.medium,
    fontSize: 10.5,
    lineHeight: 15,
    color: colors.text,
    textAlign: 'center',
    marginTop: 1,
    maxWidth: 70,
  },
  viewAllTile: {
    width: 58,
    height: 63,
    borderRadius: 16,
    backgroundColor: '#FCF5EB',
    borderWidth: 1,
    borderColor: 'rgba(233,218,196,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    marginTop: 2,
  },
  viewAllLabel: {
    fontFamily: fonts.medium,
    fontSize: 9.5,
    lineHeight: 13,
    color: colors.green,
  },
  farm: {
    position: 'absolute',
    right: -12,
    bottom: -16,
    zIndex: 4,
  },
});
