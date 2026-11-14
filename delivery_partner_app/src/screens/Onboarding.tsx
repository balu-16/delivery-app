import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Brand } from "../components/Brand";
import { Button, Text } from "../components/Ui";
import { colors, fonts } from "../theme";

const slides = [
  {
    title: "Freshness starts at the farm",
    description:
      "Pick up fresh dairy and bring a little goodness to every doorstep.",
    image: require("../../assets/images/farm-scene-hd.png"),
    icon: "cube-outline" as const,
  },
  {
    title: "Every delivery, made simple",
    description: "Follow your route and keep every stop moving smoothly.",
    image: require("../../assets/images/partner-delivery-scene.png"),
    icon: "bicycle-outline" as const,
  },
  {
    title: "A better day, every day",
    description: "Track your deliveries, earnings and progress in one place.",
    image: require("../../assets/images/crate-hd.png"),
    icon: "wallet-outline" as const,
  },
];
export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList>(null);
  const [index, setIndex] = useState(0);
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + 10,
          paddingBottom: Math.max(insets.bottom, 14),
        },
      ]}
    >
      <View style={styles.top}>
        <Brand />
        <Pressable onPress={onFinish} accessibilityRole="button" hitSlop={10}>
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>
      <FlatList
        ref={list}
        data={slides}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.title}
        getItemLayout={(_, slide) => ({
          length: width,
          offset: width * slide,
          index: slide,
        })}
        onMomentumScrollEnd={(event) =>
          setIndex(Math.round(event.nativeEvent.contentOffset.x / width))
        }
        renderItem={({ item }) => (
          <ScrollView
            style={{ width }}
            contentContainerStyle={{ paddingHorizontal: 23, paddingBottom: 12 }}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            <View
              style={[
                styles.hero,
                {
                  height:
                    height < 700
                      ? Math.max(145, height * 0.34)
                      : Math.min(height * 0.43, 390),
                },
              ]}
            >
              <Image
                source={item.image}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                contentPosition={
                  item.icon === "bicycle-outline" ? "bottom" : "center"
                }
              />
              <LinearGradient
                colors={["transparent", "rgba(48,57,18,0.18)"]}
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.heroBadge}>
                <Ionicons name={item.icon} color={colors.green} size={22} />
              </View>
            </View>
            <View style={styles.copy}>
              <Text style={styles.eyebrow}>DAIRYDIRECT PARTNER</Text>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.description}>{item.description}</Text>
            </View>
          </ScrollView>
        )}
      />
      <View style={styles.footer}>
        <View style={styles.dots}>
          {slides.map((item, i) => (
            <View
              key={item.title}
              style={[styles.dot, i === index && styles.activeDot]}
            />
          ))}
        </View>
        <Button
          label={index === slides.length - 1 ? "Get started" : "Continue"}
          icon="arrow-forward"
          onPress={() => {
            if (index === slides.length - 1) onFinish();
            else {
              const next = index + 1;
              setIndex(next);
              list.current?.scrollToIndex({ index: next, animated: true });
            }
          }}
        />
        <Text style={styles.footerNote}>A brighter morning, together.</Text>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 23,
    marginBottom: 18,
  },
  skip: { color: colors.green, fontFamily: fonts.semibold },
  hero: {
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: colors.greenSoft,
  },
  heroBadge: {
    position: "absolute",
    bottom: 15,
    right: 15,
    width: 45,
    height: 45,
    borderRadius: 15,
    backgroundColor: colors.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { paddingTop: 22 },
  eyebrow: {
    color: colors.green,
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1.3,
    marginBottom: 8,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 27,
    lineHeight: 35,
    maxWidth: 330,
  },
  description: {
    fontSize: 13,
    lineHeight: 21,
    color: colors.secondary,
    marginTop: 8,
    maxWidth: 335,
  },
  footer: { paddingHorizontal: 23, gap: 13 },
  dots: {
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    marginBottom: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 7, backgroundColor: "#D8CCB9" },
  activeDot: { width: 23, backgroundColor: colors.green },
  footerNote: { color: colors.muted, textAlign: "center", fontSize: 10 },
});
