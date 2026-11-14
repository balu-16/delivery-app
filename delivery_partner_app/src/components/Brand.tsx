import { Image } from "expo-image";
import { StyleSheet, Text as NativeText, View } from "react-native";
import { Text } from "./Ui";
import { colors, fonts } from "../theme";

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <View style={[styles.row, large && styles.large]}>
      <Image
        source={require("../../assets/images/logo-emblem.png")}
        style={{ width: large ? 52 : 36, height: large ? 52 : 36 }}
        contentFit="contain"
      />
      <View>
        <Text style={[styles.name, large && styles.largeName]}>
          Dairy<NativeText style={{ color: colors.green }}>Direct</NativeText>
        </Text>
        <Text style={[styles.partner, large && { fontSize: 12 }]}>
          DELIVERY PARTNER
        </Text>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
  large: { alignSelf: "center", gap: 7 },
  name: {
    fontFamily: fonts.bold,
    fontSize: 19,
    lineHeight: 23,
    color: colors.greenDeep,
    letterSpacing: -0.6,
  },
  largeName: { fontSize: 27, lineHeight: 31 },
  partner: {
    fontFamily: fonts.medium,
    color: colors.brown,
    letterSpacing: 1.2,
    fontSize: 8,
    lineHeight: 13,
  },
});
