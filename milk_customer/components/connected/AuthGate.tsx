import { useEffect, useState, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { AppState, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FormSkeleton } from '@/components/animations/Skeleton';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { colors, fonts } from '@/constants/theme';
import { images } from '@/constants/assets';
import { AuthError } from '@/src/auth/cognito';
import { authErrorMessage, isReferralError } from '@/src/auth/messages';
import {
  cancelPasswordChange, completePasswordChange, confirmPasswordReset, confirmSignUp, login,
  PasswordChangedError, PasswordChangeUncertainError, requestPasswordReset, resendSignUpCode, signUp, type LoginResult, type RequiredAttribute,
} from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { indianPhoneE164, indianPhoneInput } from '@/src/utils/indian-phone';

type Stage = 'login' | 'signup' | 'verify' | 'forgot' | 'reset' | 'newPassword';
type Notice = { text: string; error: boolean };
type Field = 'name' | 'email' | 'phone' | 'password' | 'newPassword' | 'code' | 'referral';

export function AuthGate({ children }: { children: ReactNode }) {
  const status = useCustomer(state => state.status);
  const initialize = useCustomer(state => state.initialize);
  const load = useCustomer(state => state.load);
  const logout = useCustomer(state => state.logout);
  const error = useCustomer(state => state.status === 'unavailable' ? state.error : null);
  const checkPendingPlacement = useCustomer(state => state.checkPendingPlacement);
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [required, setRequired] = useState<RequiredAttribute[]>([]);
  const [code, setCode] = useState('');
  const [referral, setReferral] = useState('');
  const [skipReferral, setSkipReferral] = useState(false);
  const [showReferral, setShowReferral] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fields, setFields] = useState<Partial<Record<Field, string>>>({});
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => () => cancelPasswordChange(), []);
  useEffect(() => {
    if (status !== 'signedIn') return;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active' && previous !== 'active') void checkPendingPlacement();
      previous = next;
    });
    return () => subscription.remove();
  }, [status, checkPendingPlacement]);
  if (status === 'signedIn') return <>{children}</>;

  const handleLogin = async (result: LoginResult) => {
    if (result.kind === 'newPasswordRequired') {
      setPassword('');
      setRequired(result.requiredAttributes);
      setStage('newPassword');
      setNotice({ text: 'Your temporary password was accepted. Choose a new password to finish signing in.', error: false });
      return;
    }
    setPassword(''); setNewPassword(''); setReferral('');
    await load();
  };

  const submit = async (withoutReferral = false) => {
    if (pending) return;
    const next: Partial<Record<Field, string>> = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter a valid email address.';
    if ((stage === 'signup' || (stage === 'newPassword' && required.includes('name'))) && !name.trim()) next.name = 'Enter your name.';
    if (['login', 'signup', 'reset'].includes(stage) && !password) next.password = stage === 'reset' ? 'Enter a new password.' : 'Enter your password.';
    if (stage === 'newPassword' && !newPassword) next.newPassword = 'Enter a new password.';
    if (stage === 'newPassword' && required.includes('phone_number') && !indianPhoneE164(phone)) next.phone = 'Enter a valid 10-digit Indian phone number.';
    if (['verify', 'reset'].includes(stage) && !code.trim()) next.code = 'Enter the code sent to your email.';
    if (!withoutReferral && (stage === 'login' || stage === 'signup') && referral.trim() && !/^(?:[A-F0-9]{16}|INV-[A-F0-9]{32})$/i.test(referral.trim())) next.referral = 'Enter a valid referral code.';
    setFields(next);
    if (Object.keys(next).length) return;
    setPending(true); setNotice(null); setSkipReferral(false);
    let verified = false;
    try {
      if (stage === 'signup') {
        const result = await signUp(email, password, name, referral);
        setStage(result.confirmed ? 'login' : 'verify');
        setNotice({ text: result.confirmed ? 'Account created. Sign in to continue.' : 'Check your email for a verification code.', error: false });
      } else if (stage === 'verify') {
        await confirmSignUp(email, code);
        verified = true; setCode(''); setStage('login');
        if (password) await handleLogin(await login(email, password, referral.trim() || undefined));
        else setNotice({ text: 'Email verified. You can sign in now.', error: false });
      } else if (stage === 'forgot') {
        await requestPasswordReset(email); setStage('reset');
        setNotice({ text: 'Check your email for a reset code.', error: false });
      } else if (stage === 'reset') {
        await confirmPasswordReset(email, code, password);
        setPassword(''); setCode(''); setStage('login');
        setNotice({ text: 'Password updated. Sign in to continue.', error: false });
      } else if (stage === 'newPassword') {
        await completePasswordChange(newPassword, { name, email, phone_number: indianPhoneE164(phone) ?? '' });
        setNewPassword(''); setReferral(''); await load();
      } else {
        await handleLogin(await login(email, password, withoutReferral ? null : referral.trim() || undefined));
      }
    } catch (cause) {
      if (cause instanceof PasswordChangedError) {
        setNewPassword(''); setPassword(''); setStage('login');
        if (isReferralError(cause.original)) setSkipReferral(true);
        setNotice({ text: `Password updated. ${authErrorMessage(cause.original)} Sign in with your new password to retry.`, error: true });
      } else if (cause instanceof PasswordChangeUncertainError) {
        setNewPassword(''); setPassword(''); setStage('login');
        setNotice({ text: cause.message, error: true });
      } else if (cause instanceof AuthError && !verified && cause.code === 'INVALID_PASSWORD') {
        setFields(previous => ({ ...previous, [stage === 'newPassword' ? 'newPassword' : 'password']: cause.message }));
      } else if (cause instanceof AuthError && !verified && (cause.code === 'INVALID_CODE' || cause.code === 'EXPIRED_CODE')) {
        setFields(previous => ({ ...previous, code: cause.message }));
      } else if (cause instanceof AuthError && !verified && stage === 'signup' && cause.code === 'ACCOUNT_EXISTS') {
        setFields(previous => ({ ...previous, email: cause.message }));
      } else {
        if (cause instanceof AuthError && cause.code === 'EMAIL_NOT_VERIFIED') setStage('verify');
        if (cause instanceof AuthError && cause.code === 'CHALLENGE_EXPIRED') { setStage('login'); setNewPassword(''); }
        if (isReferralError(cause)) setSkipReferral(stage === 'login' || stage === 'verify');
        setNotice({ text: `${verified ? 'Email verified. ' : ''}${authErrorMessage(cause)}`, error: true });
      }
    } finally { setPending(false); }
  };

  const resend = async () => {
    if (!email.trim() || pending) return;
    setPending(true); setNotice(null);
    try {
      await resendSignUpCode(email);
      setNotice({ text: 'Check your email for a new verification code.', error: false });
    } catch (cause) { setNotice({ text: authErrorMessage(cause), error: true }); }
    finally { setPending(false); }
  };
  const goTo = (next: Stage) => {
    cancelPasswordChange(); setNewPassword(''); setRequired([]); setStage(next); setNotice(null); setSkipReferral(false); setFields({});
  };
  const title = stage === 'signup' ? 'Create account' : stage === 'verify' ? 'Verify your email' : stage === 'forgot' ? 'Reset your password' : stage === 'reset' || stage === 'newPassword' ? 'Choose a new password' : 'Customer Login';
  const label = stage === 'login' ? 'Sign in' : stage === 'signup' ? 'Create account' : stage === 'verify' ? 'Verify email' : stage === 'forgot' ? 'Send reset code' : 'Update password';
  const clear = (field: Field) => setFields(previous => ({ ...previous, [field]: undefined }));
  const fieldError = (field: Field) => fields[field] ? <AppText accessibilityLiveRegion="polite" style={styles.errorText}>{fields[field]}</AppText> : null;

  const authScreen = (
    <View style={styles.root}>
      <View style={styles.background} pointerEvents="none">
        <Image source={images.authCountryside} style={StyleSheet.absoluteFill} contentFit="cover" />
        <LinearGradient colors={[colors.background, 'rgba(251,243,231,0.65)', 'rgba(251,243,231,0)']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView style={styles.formScroll} contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.brand}>
            <Image source={images.authLogo} style={styles.authLogo} contentFit="contain" />
            <AppText style={styles.brandText}>DairyDirect</AppText>
          </View>
          <AppText style={styles.title}>{title}</AppText>
          {stage !== 'login' && stage !== 'signup' ? <AppText style={styles.subtitle}>Use the code sent to your email to continue.</AppText> : null}
          {status === 'loading' ? <View style={styles.card}><FormSkeleton label="Restoring your account" /></View> : status === 'unavailable' ? <View style={styles.card}>
            <AppText style={styles.body}>{error ?? 'The service is temporarily unavailable.'}</AppText>
            <Button label="Try again" onPress={() => void initialize()} fullWidth />
            <Button label="Sign out" variant="soft" onPress={() => void logout()} fullWidth />
          </View> : <View style={styles.form}>
            {(stage === 'signup' || (stage === 'newPassword' && required.includes('name'))) && <><View style={[styles.field, fields.name && styles.invalid]}><Ionicons name="person-outline" size={20} color={colors.textSecondary} /><TextInput style={styles.inputText} value={name} onChangeText={value => { setName(value); clear('name'); }} placeholder="Your name" autoComplete="name" accessibilityLabel="Your name" /></View>{fieldError('name')}</>}
            <View style={[styles.field, fields.email && styles.invalid]}><Ionicons name="mail-outline" size={20} color={colors.textSecondary} /><TextInput style={styles.inputText} value={email} onChangeText={value => { setEmail(value); clear('email'); }} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" autoComplete="email" accessibilityLabel="Email address" editable={stage !== 'newPassword'} /></View>{fieldError('email')}
            {stage === 'newPassword' && required.includes('phone_number') && <><View style={[styles.field, fields.phone && styles.invalid]}><AppText style={styles.prefix}>+91</AppText><TextInput style={[styles.inputText, { paddingVertical: 0 }]} value={phone} onChangeText={value => { setPhone(indianPhoneInput(value)); clear('phone'); }} placeholder="10-digit phone number" keyboardType="phone-pad" autoComplete="tel-national" accessibilityLabel="Phone number" /></View>{fieldError('phone')}</>}
            {(stage === 'login' || stage === 'signup' || stage === 'reset') && <><View style={[styles.field, fields.password && styles.invalid]}><Ionicons name="lock-closed-outline" size={20} color={colors.textSecondary} /><TextInput style={styles.inputText} value={password} onChangeText={value => { setPassword(value); clear('password'); }} placeholder={stage === 'reset' ? 'New password' : 'Password'} secureTextEntry={!showPassword} autoComplete={stage === 'login' ? 'current-password' : 'new-password'} accessibilityLabel={stage === 'reset' ? 'New password' : 'Password'} /><Pressable onPress={() => setShowPassword(value => !value)} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} hitSlop={8}><Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={21} color={colors.textSecondary} /></Pressable></View>{fieldError('password')}</>}
            {stage === 'newPassword' && <><View style={[styles.field, fields.newPassword && styles.invalid]}><Ionicons name="lock-closed-outline" size={20} color={colors.textSecondary} /><TextInput style={styles.inputText} value={newPassword} onChangeText={value => { setNewPassword(value); clear('newPassword'); }} placeholder="New password" secureTextEntry={!showPassword} autoComplete="new-password" accessibilityLabel="New password" /><Pressable onPress={() => setShowPassword(value => !value)} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} hitSlop={8}><Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={21} color={colors.textSecondary} /></Pressable></View>{fieldError('newPassword')}</>}
            {(stage === 'login' || stage === 'signup') && <View style={styles.linkRow}>
              <Pressable onPress={() => setShowReferral(value => !value)} accessibilityRole="button" accessibilityLabel={showReferral ? 'Hide referral code' : 'Add referral code'} hitSlop={6}><AppText style={styles.link}>{showReferral ? 'Hide referral code' : 'Add referral code'}</AppText></Pressable>
              {stage === 'login' && <Pressable onPress={() => goTo('forgot')} accessibilityRole="button" accessibilityLabel="Forgot password?" hitSlop={6}><AppText style={styles.link}>Forgot password?</AppText></Pressable>}
            </View>}
            {(stage === 'login' || stage === 'signup') && showReferral && <><View style={[styles.field, fields.referral && styles.invalid]}><Ionicons name="ticket-outline" size={20} color={colors.textSecondary} /><TextInput style={styles.inputText} value={referral} onChangeText={value => { setReferral(value); clear('referral'); }} placeholder="Referral code (optional)" autoCapitalize="characters" maxLength={36} accessibilityLabel="Referral code" /></View>{fieldError('referral')}</>}
            {(stage === 'verify' || stage === 'reset') && <><View style={[styles.field, fields.code && styles.invalid]}><Ionicons name="key-outline" size={20} color={colors.textSecondary} /><TextInput style={styles.inputText} value={code} onChangeText={value => { setCode(value); clear('code'); }} placeholder={stage === 'reset' ? 'Password reset code' : 'Email verification code'} keyboardType="number-pad" accessibilityLabel={stage === 'reset' ? 'Password reset code' : 'Verification code'} /></View>{fieldError('code')}</>}
            {notice && <View accessibilityLiveRegion="polite" style={[styles.notice, notice.error ? styles.errorNotice : styles.infoNotice]}><AppText style={[styles.body, notice.error && styles.errorText]}>{notice.text}</AppText></View>}
            <Button label={label} fullWidth onPress={() => void submit()} loading={pending} disabled={pending} style={styles.primaryBtn} />
            {skipReferral && <Button label="Sign in without referral" variant="soft" fullWidth disabled={pending || !email.trim() || !password} onPress={() => void submit(true)} />}
            {stage === 'verify' && <Button label="Resend verification code" variant="ghost" fullWidth disabled={pending || !email.trim()} onPress={() => void resend()} />}
            {stage === 'login' ? <><View style={styles.footerRow}><AppText style={styles.footerText}>New here? </AppText><Pressable onPress={() => goTo('signup')} accessibilityRole="button" accessibilityLabel="Create account"><AppText style={styles.link}>Create account</AppText></Pressable></View><Pressable style={styles.footerCenter} onPress={() => goTo('verify')} accessibilityRole="button" accessibilityLabel="Verify email"><AppText style={styles.link}>Verify email</AppText></Pressable></> : stage === 'signup' ? <View style={styles.footerRow}><AppText style={styles.footerText}>Already have an account? </AppText><Pressable onPress={() => goTo('login')} accessibilityRole="button" accessibilityLabel="Sign in"><AppText style={styles.link}>Sign in</AppText></Pressable></View> : <Button label="Back to sign in" variant="soft" fullWidth disabled={pending} onPress={() => goTo('login')} />}
          </View>}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
  return authScreen;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  background: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '54%' },
  formScroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, gap: 14 },
  brand: { alignItems: 'center', gap: 2 },
  authLogo: { width: 150, height: 76 },
  brandText: { fontFamily: fonts.bold, fontSize: 26, lineHeight: 32, color: colors.greenDark },
  title: { fontFamily: fonts.bold, fontSize: 27, lineHeight: 34, color: colors.greenDark },
  subtitle: { color: colors.textSecondary, textAlign: 'center', fontSize: 13 },
  card: { width: '100%', padding: 18, borderRadius: 20, backgroundColor: colors.surfaceRaised, gap: 12, borderWidth: 1, borderColor: colors.line },
  form: { gap: 12 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: 'rgba(255,252,246,0.92)', borderRadius: 14, paddingHorizontal: 14 },
  invalid: { borderColor: colors.danger },
  inputText: { flex: 1, minHeight: 52, color: colors.text, fontSize: 15 },
  prefix: { color: colors.text, borderRightWidth: 1, borderRightColor: colors.lineStrong, paddingRight: 10 },
  body: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  notice: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  errorNotice: { backgroundColor: colors.dangerSoft }, infoNotice: { backgroundColor: colors.greenSoft },
  errorText: { color: colors.danger },
  linkRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: colors.green, fontFamily: fonts.semibold, fontSize: 14, textDecorationLine: 'underline' },
  primaryBtn: { borderRadius: 14 },
  footerRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 8 },
  footerCenter: { alignSelf: 'center', marginTop: 6 },
  footerText: { color: colors.text, fontSize: 14 },
});
