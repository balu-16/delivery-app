import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { colors, fonts } from '@/constants/theme';
import { images } from '@/constants/assets';
import { confirmPasswordReset, confirmSignUp, login, requestPasswordReset, resendSignUpCode, signUp } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { ApiError } from '@/src/api/client';

type Stage = 'login' | 'signup' | 'verify' | 'forgot' | 'reset';
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, initialize, load, logout, error } = useCustomer();
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [referral, setReferral] = useState('');
  const [skipReferral, setSkipReferral] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { void initialize(); }, [initialize]);
  if (status === 'signedIn') return <>{children}</>;
  const submit = async (withoutReferral = false) => {
    if (pending) return;
    setPending(true); setMessage(''); setSkipReferral(false);
    try {
      if (stage === 'signup') { await signUp(email, password, name, referral); setStage('verify'); setMessage('Check your email for a verification code.'); }
      else if (stage === 'verify') {
        await confirmSignUp(email, code); setCode(''); setStage('login');
        if (password) {await login(email,password,referral.trim() || undefined);setPassword('');setReferral('');await load();}
        else setMessage('Email verified. You can sign in now.');
      }
      else if (stage === 'forgot') { await requestPasswordReset(email); setStage('reset'); setMessage('Check your email for a reset code.'); }
      else if (stage === 'reset') { await confirmPasswordReset(email, code, password); setPassword(''); setCode(''); setStage('login'); setMessage('Password updated. Sign in to continue.'); }
      else { await login(email, password, withoutReferral ? null : referral.trim() || undefined); setPassword(''); setReferral(''); await load(); }
    } catch (cause) {
      if (cause instanceof ApiError && ['INVALID_REFERRAL_CODE','REFERRAL_SIGNUP_ONLY','REFERRALS_UNAVAILABLE'].includes(cause.code)) {setMessage(cause.code === 'REFERRALS_UNAVAILABLE' ? 'Referral rewards are temporarily unavailable. Try later or continue without the referral.' : 'This referral code cannot be applied to this account. Check the code or continue without it.');setSkipReferral(stage === 'login' || stage === 'verify');}
      else if (cause instanceof Error && cause.message.startsWith('Enter a valid 16-character')) setMessage(cause.message);
      else setMessage('Unable to complete the request. Check your details and connection, then try again.');
    }
    finally { setPending(false); }
  };
  const resend = async () => {if (!email.trim() || pending) return;setPending(true);setMessage('');try {await resendSignUpCode(email);setMessage('Check your email for a new verification code.');} catch {setMessage('Could not send a code. Check your email and try again.');} finally {setPending(false);}};
  const title = stage === 'signup' ? 'Create your account' : stage === 'verify' ? 'Verify your email' : stage === 'forgot' ? 'Reset your password' : stage === 'reset' ? 'Choose a new password' : 'Welcome to DairyDirect';
  return <Screen><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]}>
    <Image source={images.logoEmblem} style={styles.logo} contentFit="contain" />
    <AppText style={styles.title}>{title}</AppText>
    <AppText style={styles.subtitle}>Sign in to see your deliveries, dairy and wallet.</AppText>
    {status === 'loading' ? <ActivityIndicator color={colors.green} /> : status === 'unavailable' ? <View style={styles.card}>
      <AppText style={styles.body}>{error ?? 'The service is temporarily unavailable.'}</AppText>
      <Button label="Try again" onPress={() => void initialize()} fullWidth />
      <Button label="Sign out" variant="soft" onPress={() => void logout()} fullWidth />
    </View> : <View style={styles.card}>
      {stage === 'signup' && <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Your name" autoComplete="name" accessibilityLabel="Your name" />}
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" autoComplete="email" accessibilityLabel="Email address" />
      {(stage === 'login' || stage === 'signup' || stage === 'reset') && <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder={stage === 'reset' ? 'New password' : 'Password'} secureTextEntry autoComplete={stage === 'login' ? 'current-password' : 'new-password'} accessibilityLabel="Password" />}
      {(stage === 'login' || stage === 'signup') && <TextInput style={styles.input} value={referral} onChangeText={setReferral} placeholder="Referral code (optional for new accounts)" autoCapitalize="characters" maxLength={16} accessibilityLabel="Referral code" />}
      {(stage === 'verify' || stage === 'reset') && <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="Email verification code" keyboardType="number-pad" accessibilityLabel="Verification code" />}
      {!!message && <AppText style={styles.body}>{message}</AppText>}
      <Button label={stage === 'login' ? 'Sign in' : stage === 'signup' ? 'Create account' : stage === 'verify' ? 'Verify email' : stage === 'forgot' ? 'Send reset code' : 'Update password'} fullWidth onPress={() => void submit()} loading={pending} disabled={pending || !email.trim() || (stage === 'signup' && !name.trim()) || (['login', 'signup', 'reset'].includes(stage) && !password) || (['verify', 'reset'].includes(stage) && !code.trim())} />
      {skipReferral && <Button label="Sign in without referral" variant="soft" fullWidth disabled={pending} onPress={() => void submit(true)} />}
      {stage === 'verify' && <Button label="Resend verification code" variant="ghost" fullWidth disabled={pending || !email.trim()} onPress={() => void resend()} />}
      {stage === 'login' ? <><Button label="Create account" variant="soft" fullWidth onPress={() => { setStage('signup'); setMessage(''); }} /><Button label="Verify email" variant="ghost" fullWidth onPress={() => { setStage('verify'); setMessage(''); }} /><Button label="Forgot password?" variant="ghost" fullWidth onPress={() => { setStage('forgot'); setMessage(''); }} /></> : <Button label="Back to sign in" variant="soft" fullWidth onPress={() => { setStage('login'); setMessage(''); }} />}
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
});
