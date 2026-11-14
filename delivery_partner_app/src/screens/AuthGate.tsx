import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthError } from "../auth/cognito";
import {
  completeNewPassword,
  confirmPassword,
  confirmSignUp,
  forgotPassword,
  PasswordChangedError,
  PasswordChangeUncertainError,
  resendCode,
  signIn,
  signUp,
  type PartnerIdentity,
} from "../auth/session";
import { Brand } from "../components/Brand";
import { Button, Text } from "../components/Ui";
import { useDemo } from "../store";
import { translatePartner } from "../partnerI18n";
import { colors, fonts } from "../theme";

type Stage = "login" | "signup" | "verify" | "forgot" | "reset" | "newPassword";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthGate({
  onSignedIn,
}: {
  onSignedIn: (identity: PartnerIdentity) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const language = useDemo((state) => state.language);
  const t = (value: string) => translatePartner(value, language);
  const [stage, setStage] = useState<Stage>("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [required, setRequired] = useState<string[]>([]);
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const go = (next: Stage) => {
    setStage(next);
    setPassword("");
    setCode("");
    setNotice(null);
    setVisible(false);
  };
  const title =
    stage === "signup"
      ? "Create your account"
      : stage === "verify"
        ? "Verify your email"
        : stage === "forgot"
          ? "Forgot your password?"
          : stage === "reset" || stage === "newPassword"
            ? "Choose a new password"
            : "Partner login";
  const subtitle =
    stage === "signup"
      ? "Join the DairyDirect partner community."
      : stage === "verify"
        ? "Enter the verification code sent to your email."
        : stage === "forgot"
          ? "We will send a reset code to your email."
          : stage === "reset"
            ? "Enter your reset code and a new password."
            : stage === "newPassword"
              ? "Set a new password to finish signing in."
              : "Sign in to start your day with DairyDirect.";
  const label =
    stage === "login"
      ? "Sign in"
      : stage === "signup"
        ? "Create account"
        : stage === "verify"
          ? "Verify email"
          : stage === "forgot"
            ? "Send reset code"
            : "Update password";
  async function submit() {
    if (!emailPattern.test(email.trim())) {
      setNotice({ text: "Enter a valid email address.", error: true });
      return;
    }
    if (
      (stage === "signup" ||
        (stage === "newPassword" && required.includes("name"))) &&
      !name.trim()
    ) {
      setNotice({ text: "Enter your name.", error: true });
      return;
    }
    if (
      ["login", "signup", "reset", "newPassword"].includes(stage) &&
      !password
    ) {
      setNotice({ text: "Enter your password.", error: true });
      return;
    }
    if (["verify", "reset"].includes(stage) && !code.trim()) {
      setNotice({ text: "Enter the code from your email.", error: true });
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      if (stage === "signup") {
        const result = await signUp(email, password, name);
        setPassword("");
        setStage(result.UserConfirmed ? "login" : "verify");
        setNotice({
          text: result.UserConfirmed
            ? "Account created. Sign in to continue."
            : "Check your email for a verification code.",
          error: false,
        });
      } else if (stage === "verify") {
        await confirmSignUp(email, code);
        setCode("");
        setStage("login");
        setNotice({
          text: "Email verified. Sign in to continue.",
          error: false,
        });
      } else if (stage === "forgot") {
        await forgotPassword(email);
        setStage("reset");
        setNotice({ text: "Check your email for a reset code.", error: false });
      } else if (stage === "reset") {
        await confirmPassword(email, code, password);
        setPassword("");
        setCode("");
        setStage("login");
        setNotice({
          text: "Password updated. Sign in to continue.",
          error: false,
        });
      } else if (stage === "newPassword") {
        const identity = await completeNewPassword(password, {
          email,
          name,
          phone_number: phone,
        });
        setPassword("");
        await onSignedIn(identity);
      } else {
        const result = await signIn(email, password);
        setPassword("");
        if (result.kind === "newPassword") {
          setRequired(result.required);
          setStage("newPassword");
        } else await onSignedIn(result.identity);
      }
    } catch (error) {
      if (
        error instanceof PasswordChangedError ||
        error instanceof PasswordChangeUncertainError
      ) {
        setPassword("");
        setStage("login");
      }
      setNotice({
        text:
          error instanceof AuthError ||
          error instanceof PasswordChangedError ||
          error instanceof PasswordChangeUncertainError
            ? error.message
            : "We could not complete this request. Please try again.",
        error: true,
      });
    } finally {
      setPending(false);
    }
  }
  async function resend() {
    if (!emailPattern.test(email.trim())) {
      setNotice({ text: "Enter a valid email address.", error: true });
      return;
    }
    setPending(true);
    try {
      await resendCode(email);
      setNotice({ text: "A new code was sent to your email.", error: false });
    } catch (error) {
      setNotice({
        text:
          error instanceof AuthError
            ? error.message
            : "We could not send the code. Try again.",
        error: true,
      });
    } finally {
      setPending(false);
    }
  }
  const input = (
    value: string,
    change: (value: string) => void,
    placeholder: string,
    options: {
      email?: boolean;
      password?: boolean;
      number?: boolean;
      editable?: boolean;
      autoComplete?:
        "email" | "name" | "tel" | "current-password" | "new-password";
    } = {},
  ) => (
    <View style={styles.inputWrap}>
      <TextInput
        accessibilityLabel={t(placeholder)}
        style={styles.input}
        value={value}
        onChangeText={change}
        placeholder={t(placeholder)}
        placeholderTextColor={colors.muted}
        autoCapitalize={
          options.email || options.password ? "none" : "sentences"
        }
        autoCorrect={!options.email && !options.password}
        keyboardType={
          options.email
            ? "email-address"
            : options.number
              ? "number-pad"
              : "default"
        }
        secureTextEntry={options.password && !visible}
        autoComplete={options.autoComplete}
        editable={options.editable !== false && !pending}
      />
      {options.password && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? t("Hide password") : t("Show password")}
          onPress={() => setVisible(!visible)}
          hitSlop={8}
        >
          <Ionicons
            name={visible ? "eye-off-outline" : "eye-outline"}
            size={21}
            color={colors.secondary}
          />
        </Pressable>
      )}
    </View>
  );
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + 25,
            paddingBottom: Math.max(insets.bottom, 20),
          },
        ]}
      >
        <Brand large />
        <View style={styles.content}>
          <View style={styles.eyebrow}>
            <Ionicons name="leaf" size={14} color={colors.green} />
            <Text style={styles.eyebrowText}>WELCOME, PARTNER</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <View style={styles.form}>
            {(stage === "signup" ||
              (stage === "newPassword" && required.includes("name"))) &&
              input(name, setName, "Your name", { autoComplete: "name" })}
            {input(email, setEmail, "Email address", {
              email: true,
              autoComplete: "email",
              editable: stage !== "newPassword",
            })}
            {stage === "newPassword" &&
              required.includes("phone_number") &&
              input(phone, setPhone, "Phone number with country code", {
                autoComplete: "tel",
              })}
            {(stage === "verify" || stage === "reset") &&
              input(code, setCode, "Email verification code", { number: true })}
            {["login", "signup", "reset", "newPassword"].includes(stage) &&
              input(
                password,
                setPassword,
                stage === "reset" || stage === "newPassword"
                  ? "New password"
                  : "Password",
                {
                  password: true,
                  autoComplete:
                    stage === "login" ? "current-password" : "new-password",
                },
              )}
            {stage === "login" && (
              <Pressable
                onPress={() => go("forgot")}
                disabled={pending}
                accessibilityRole="button"
                style={styles.forgot}
              >
                <Text style={styles.link}>Forgot password?</Text>
              </Pressable>
            )}
            {notice && (
              <Text
                accessibilityRole="alert"
                style={[styles.notice, notice.error && styles.error]}
              >
                {notice.text}
              </Text>
            )}
            <Button
              label={pending ? "Please wait…" : label}
              disabled={pending}
              onPress={() => void submit()}
            />
            {stage === "verify" && (
              <Pressable
                onPress={() => void resend()}
                disabled={pending}
                style={styles.centerLink}
              >
                <Text style={styles.link}>Resend code</Text>
              </Pressable>
            )}
            {stage === "login" ? (
              <View style={styles.accountRow}>
                <Text style={styles.small}>New to DairyDirect? </Text>
                <Pressable onPress={() => go("signup")} disabled={pending}>
                  <Text style={styles.link}>Create account</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={styles.centerLink}
                onPress={() => go("login")}
                disabled={pending}
              >
                <Text style={styles.link}>Back to sign in</Text>
              </Pressable>
            )}
            {stage === "login" && (
              <Pressable
                style={styles.centerLink}
                onPress={() => go("verify")}
                disabled={pending}
              >
                <Text style={styles.small}>
                  Already signed up? Verify your email
                </Text>
              </Pressable>
            )}
          </View>
        </View>
        <View style={styles.art}>
          <Image
            source={require("../../assets/images/partner-delivery-scene.png")}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            contentPosition="bottom"
          />
          <View style={styles.artLabel}>
            <Ionicons name="leaf" size={16} color={colors.green} />
            <Text style={styles.artText}>From our farms to every home</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, paddingHorizontal: 23 },
  content: {
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
    paddingTop: 32,
  },
  eyebrow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  eyebrowText: {
    color: colors.green,
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1,
  },
  title: { fontFamily: fonts.bold, fontSize: 27, lineHeight: 35 },
  subtitle: {
    color: colors.secondary,
    fontSize: 13,
    marginTop: 5,
    lineHeight: 20,
  },
  form: { gap: 11, marginTop: 23 },
  inputWrap: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: 13,
    backgroundColor: colors.raised,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    minHeight: 50,
    fontFamily: fonts.regular,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 0,
  },
  forgot: { alignSelf: "flex-end" },
  link: { color: colors.green, fontFamily: fonts.semibold, fontSize: 12 },
  notice: {
    color: colors.greenDark,
    backgroundColor: colors.greenSoft,
    padding: 10,
    borderRadius: 10,
    fontSize: 12,
  },
  error: { color: colors.danger, backgroundColor: "#FBE7E2" },
  accountRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 3,
  },
  small: { color: colors.secondary, fontSize: 12 },
  centerLink: { alignItems: "center", paddingVertical: 3 },
  art: {
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
    height: 155,
    borderRadius: 18,
    marginTop: 24,
    overflow: "hidden",
    backgroundColor: colors.greenSoft,
  },
  artLabel: {
    position: "absolute",
    left: 12,
    bottom: 12,
    backgroundColor: colors.raised,
    borderRadius: 10,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  artText: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    color: colors.greenDark,
  },
});
