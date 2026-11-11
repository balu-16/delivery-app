import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { colors, fonts } from '@/constants/theme';
import { images } from '@/constants/assets';
import { AuthError } from '@/src/auth/cognito';
import { authErrorMessage, isReferralError } from '@/src/auth/messages';
import {
  cancelPasswordChange, completePasswordChange, confirmPasswordReset, confirmSignUp, login,
  PasswordChangedError, PasswordChangeUncertainError, requestPasswordReset, resendSignUpCode, signUp, type LoginResult, type RequiredAttribute,
} from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';

type Stage = 'login' | 'signup' | 'verify' | 'forgot' | 'reset' | 'newPassword';
type Notice = { text: string; error: boolean };

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, initialize, load, logout, error } = useCustomer();
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
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => () => cancelPasswordChange(), []);
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
        await completePasswordChange(newPassword, { name, email, phone_number: phone });
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
    cancelPasswordChange(); setNewPassword(''); setRequired([]); setStage(next); setNotice(null); setSkipReferral(false);
  };
  const title = stage === 'signup' ? 'Create your account' : stage === 'verify' ? 'Verify your email' : stage === 'forgot' ? 'Reset your password' : stage === 'reset' || stage === 'newPassword' ? 'Choose a new password' : 'Welcome to DairyDirect';
  const label = stage === 'login' ? 'Sign in' : stage === 'signup' ? 'Create account' : stage === 'verify' ? 'Verify email' : stage === 'forgot' ? 'Send reset code' : 'Update password';
  const disabled = pending || !email.trim() || (stage === 'signup' && !name.trim()) || (['login', 'signup', 'reset'].includes(stage) && !password) || (['verify', 'reset'].includes(stage) && !code.trim()) || (stage === 'newPassword' && (!newPassword || (required.includes('name') && !name.trim()) || (required.includes('phone_number') && !phone.trim())));

  return <Screen><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]}>
    <Image source={images.logoEmblem} style={styles.logo} contentFit="contain" />
    <AppText style={styles.title}>{title}</AppText>
    <AppText style={styles.subtitle}>Sign in to see your deliveries, dairy and wallet.</AppText>
    {status === 'loading' ? <ActivityIndicator color={colors.green} /> : status === 'unavailable' ? <View style={styles.card}>
      <AppText style={styles.body}>{error ?? 'The service is temporarily unavailable.'}</AppText>
      <Button label="Try again" onPress={() => void initialize()} fullWidth />
      <Button label="Sign out" variant="soft" onPress={() => void logout()} fullWidth />
    </View> : <View style={styles.card}>
      {(stage === 'signup' || (stage === 'newPassword' && required.includes('name'))) && <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Your name" autoComplete="name" accessibilityLabel="Your name" />}
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" autoComplete="email" accessibilityLabel="Email address" editable={stage !== 'newPassword'} />
      {stage === 'newPassword' && required.includes('phone_number') && <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="Phone number with country code" keyboardType="phone-pad" autoComplete="tel" accessibilityLabel="Phone number with country code" />}
      {(stage === 'login' || stage === 'signup' || stage === 'reset') && <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder={stage === 'reset' ? 'New password' : 'Password'} secureTextEntry autoComplete={stage === 'login' ? 'current-password' : 'new-password'} accessibilityLabel={stage === 'reset' ? 'New password' : 'Password'} />}
      {stage === 'newPassword' && <TextInput style={styles.input} value={newPassword} onChangeText={setNewPassword} placeholder="New password" secureTextEntry autoComplete="new-password" accessibilityLabel="New password" />}
      {(stage === 'login' || stage === 'signup') && <TextInput style={styles.input} value={referral} onChangeText={setReferral} placeholder="Referral code (optional for new accounts)" autoCapitalize="characters" maxLength={16} accessibilityLabel="Referral code" />}
      {(stage === 'verify' || stage === 'reset') && <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder={stage === 'reset' ? 'Password reset code' : 'Email verification code'} keyboardType="number-pad" accessibilityLabel={stage === 'reset' ? 'Password reset code' : 'Verification code'} />}
      {notice && <View accessibilityLiveRegion="polite" style={[styles.notice, notice.error ? styles.errorNotice : styles.infoNotice]}><AppText style={[styles.body, notice.error && styles.errorText]}>{notice.text}</AppText></View>}
      <Button label={label} fullWidth onPress={() => void submit()} loading={pending} disabled={disabled} />
      {skipReferral && <Button label="Sign in without referral" variant="soft" fullWidth disabled={pending || !email.trim() || !password} onPress={() => void submit(true)} />}
      {stage === 'verify' && <Button label="Resend verification code" variant="ghost" fullWidth disabled={pending || !email.trim()} onPress={() => void resend()} />}
      {stage === 'login' ? <><Button label="Create account" variant="soft" fullWidth disabled={pending} onPress={() => goTo('signup')} /><Button label="Verify email" variant="ghost" fullWidth disabled={pending} onPress={() => goTo('verify')} /><Button label="Forgot password?" variant="ghost" fullWidth disabled={pending} onPress={() => goTo('forgot')} /></> : <Button label="Back to sign in" variant="soft" fullWidth disabled={pending} onPress={() => goTo('login')} />}
    </View>}
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 22, gap: 12 },
  logo: { width: 85, height: 78 }, title: { fontFamily: fonts.bold, fontSize: 25, color: colors.brownDark, textAlign: 'center' },
  subtitle: { color: colors.textSecondary, textAlign: 'center', fontSize: 13 },
  card: { width: '100%', maxWidth: 420, padding: 18, borderRadius: 20, backgroundColor: colors.surfaceRaised, gap: 12, borderWidth: 1, borderColor: colors.line },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 12, color: colors.text },
  body: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  notice: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  errorNotice: { backgroundColor: colors.dangerSoft }, infoNotice: { backgroundColor: colors.greenSoft },
  errorText: { color: colors.danger },
});
