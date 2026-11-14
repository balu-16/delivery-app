import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  restoreSession,
  signOut,
  type PartnerIdentity,
} from "../src/auth/session";
import { Brand } from "../src/components/Brand";
import { Button, Text } from "../src/components/Ui";
import { AuthGate } from "../src/screens/AuthGate";
import { Onboarding } from "../src/screens/Onboarding";
import { PartnerApp } from "../src/screens/PartnerApp";
import { activateDemoAccount, clearDemoAccount } from "../src/store";
import { colors } from "../src/theme";

const INTRO_KEY = "@dairydirect/partner-introduction-v2";
export default function Index() {
  const [loading, setLoading] = useState(true);
  const [introDone, setIntroDone] = useState(false);
  const [identity, setIdentity] = useState<PartnerIdentity | null>(null);
  const [restoreError, setRestoreError] = useState(false);
  async function initialize() {
    setLoading(true);
    setRestoreError(false);
    const intro = await AsyncStorage.getItem(INTRO_KEY).catch(() => null);
    setIntroDone(intro === "done");
    try {
      const restored = await restoreSession();
      if (restored) {
        await activateDemoAccount(restored.subject);
        setIdentity(restored);
      }
    } catch {
      setRestoreError(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void initialize(), 0);
    return () => clearTimeout(timer);
  }, []);
  async function finishIntro() {
    setIntroDone(true);
    await AsyncStorage.setItem(INTRO_KEY, "done").catch(() => {});
  }
  async function finishSignIn(next: PartnerIdentity) {
    await activateDemoAccount(next.subject);
    setIdentity(next);
  }
  async function leave() {
    await signOut();
    await clearDemoAccount();
    setIdentity(null);
  }
  if (loading)
    return (
      <View style={styles.center}>
        <Brand large />
        <ActivityIndicator color={colors.green} style={{ marginTop: 22 }} />
        <Text style={{ marginTop: 10, color: colors.secondary }}>
          Getting things ready…
        </Text>
      </View>
    );
  if (!introDone) return <Onboarding onFinish={() => void finishIntro()} />;
  if (restoreError)
    return (
      <View style={styles.center}>
        <Brand large />
        <Text style={styles.error}>
          Could not restore your session. Check your connection and try again.
        </Text>
        <View style={{ width: "100%", gap: 10 }}>
          <Button label="Try again" onPress={() => void initialize()} />
          <Button
            label="Sign in instead"
            secondary
            onPress={() =>
              void signOut().then(() => {
                setIdentity(null);
                setRestoreError(false);
              })
            }
          />
        </View>
      </View>
    );
  if (!identity) return <AuthGate onSignedIn={finishSignIn} />;
  return <PartnerApp identity={identity} onSignOut={leave} />;
}
const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    padding: 28,
    gap: 12,
  },
  error: {
    color: colors.secondary,
    textAlign: "center",
    marginVertical: 15,
    lineHeight: 21,
  },
});
