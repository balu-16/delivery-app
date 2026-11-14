import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Eye, EyeOff, LogIn, ShieldCheck, KeyRound, ArrowLeft } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button, Input, Label } from '@/components/ui/base'
import { Logo } from '@/illustrations/Logo'
import { LoginHero } from '@/illustrations/scenes'
import { useAuth } from '@/store/auth'

type View = 'password' | 'challenge' | 'forgot' | 'confirm'

const GENERIC_LOGIN_ERROR = 'Invalid email or password.'
const GENERIC_SENT_NOTE = 'If the account exists, a reset code was sent.'

/** Password policy hint — enforced again by the server. */
function passwordIssue(pw: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.'
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number.'
  return null
}

export function Login() {
  const status = useAuth((s) => s.status)
  const admin = useAuth((s) => s.admin)
  const navigate = useNavigate()

  const [view, setView] = useState<View>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [confirmationCode, setConfirmationCode] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated' && admin) return <Navigate to="/dashboard" replace />

  const reset = () => { setError(''); setNotice('') }

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); reset()
    const res = await useAuth.getState().login(email.trim(), password)
    setBusy(false)
    if (!res.ok) {
      if (res.challenge === 'NEW_PASSWORD_REQUIRED') {
        startChallenge(res.challengeId ?? '')
        setError('')
        return
      }
      setError(res.error ?? GENERIC_LOGIN_ERROR)
      return
    }
    toast.success('Welcome back to DairyDirect')
    navigate('/dashboard', { replace: true })
  }

  const submitChallenge = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challengeId) return
    const issue = passwordIssue(newPassword)
    if (issue) { setError(issue); return }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return }
    setBusy(true)
    const res = await useAuth.getState().challenge(challengeId, newPassword)
    setBusy(false)
    if (!res.ok) { setError(res.error ?? 'Could not set the new password.'); return }
    toast.success('Password updated — welcome back')
    navigate('/dashboard', { replace: true })
  }

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); reset()
    await useAuth.getState().forgotPassword(email.trim())
    setBusy(false)
    setNotice(GENERIC_SENT_NOTE)
    setView('confirm')
  }

  const submitConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    const issue = passwordIssue(newPassword)
    if (issue) { setError(issue); return }
    setBusy(true); reset()
    const res = await useAuth.getState().confirmReset(email.trim(), confirmationCode.trim(), newPassword)
    setBusy(false)
    if (!res.ok) { setError(res.error ?? 'Invalid reset code or password.'); return }
    toast.success('Password reset — sign in with the new password')
    setView('password')
    setPassword('')
  }

  const onLoginEmailChange = (v: string) => { setEmail(v); setChallengeId(null) }
  const startChallenge = (id: string) => { setChallengeId(id); setView('challenge') }

  return (
    <div className="page-bg grid min-h-full place-items-center p-4 sm:p-8">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="grid w-full max-w-4xl overflow-hidden rounded-card border border-border bg-card shadow-lift lg:grid-cols-2"
      >
        {/* form */}
        <div className="p-7 sm:p-10">
          <Logo />
          {view === 'password' && (
            <>
              <h1 className="mt-8 text-2xl font-extrabold tracking-tight">Sign in to the Admin Portal</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">Run stores, products, orders, riders and payments across Maharashtra.</p>
              <form onSubmit={submitLogin} className="mt-7 space-y-4">
                <div>
                  <Label htmlFor="email" required>Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => onLoginEmailChange(e.target.value)} placeholder="you@company.in" autoComplete="email" required />
                </div>
                <div>
                  <Label htmlFor="password" required>Password</Label>
                  <div className="relative">
                    <Input id="password" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
                    <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Toggle password visibility">
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  <LogIn className="h-4 w-4" /> {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
              <button type="button" onClick={() => { reset(); setView('forgot') }} className="mt-4 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
                Forgot password?
              </button>
            </>
          )}

          {view === 'challenge' && (
            <>
              <h1 className="mt-8 text-2xl font-extrabold tracking-tight">Set a new password</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">Your account requires a password update before signing in.</p>
              <form onSubmit={submitChallenge} className="mt-7 space-y-4">
                <div>
                  <Label htmlFor="new-password" required>New password</Label>
                  <div className="relative">
                    <Input id="new-password" type={show ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••••••" autoComplete="new-password" required />
                    <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Toggle password visibility">
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Min 12 characters with at least one letter and one number.</p>
                </div>
                <div>
                  <Label htmlFor="confirm-password" required>Confirm password</Label>
                  <Input id="confirm-password" type={show ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
                </div>
                {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}
                <Button type="submit" size="lg" className="w-full" disabled={busy || !challengeId}>
                  <KeyRound className="h-4 w-4" /> {busy ? 'Saving…' : 'Set password & sign in'}
                </Button>
              </form>
            </>
          )}

          {view === 'forgot' && (
            <>
              <h1 className="mt-8 text-2xl font-extrabold tracking-tight">Reset your password</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">We'll send a reset code to your email.</p>
              <form onSubmit={submitForgot} className="mt-7 space-y-4">
                <div>
                  <Label htmlFor="forgot-email" required>Email</Label>
                  <Input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                </div>
                {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  {busy ? 'Sending…' : 'Send reset code'}
                </Button>
              </form>
              <button type="button" onClick={() => { reset(); setView('password') }} className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </button>
            </>
          )}

          {view === 'confirm' && (
            <>
              <h1 className="mt-8 text-2xl font-extrabold tracking-tight">Enter the reset code</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">{notice || GENERIC_SENT_NOTE}</p>
              <form onSubmit={submitConfirm} className="mt-7 space-y-4">
                <div>
                  <Label htmlFor="confirm-email" required>Email</Label>
                  <Input id="confirm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                </div>
                <div>
                  <Label htmlFor="confirm-code" required>Reset code</Label>
                  <Input id="confirm-code" value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value)} placeholder="6-digit code" required />
                </div>
                <div>
                  <Label htmlFor="confirm-new-password" required>New password</Label>
                  <Input id="confirm-new-password" type={show ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required />
                  <p className="mt-1 text-[11px] text-muted-foreground">Min 12 characters with at least one letter and one number.</p>
                </div>
                {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  {busy ? 'Resetting…' : 'Reset password'}
                </Button>
              </form>
              <button type="button" onClick={() => { reset(); setView('password') }} className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </button>
            </>
          )}

          <div className="mt-6 rounded-xl bg-primary-softer p-4">
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-700 dark:text-brand-300">
              <ShieldCheck className="h-3.5 w-3.5" /> Sessions are cookie-based
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              Nothing about your session is stored in this browser. Signing out revokes the session on the server.
            </p>
          </div>
        </div>
        {/* hero */}
        <div className="relative hidden items-center justify-center bg-gradient-to-br from-brand-50 to-cream p-8 lg:flex dark:from-brand-500/5 dark:to-transparent">
          <LoginHero className="w-full max-w-[420px]" />
          <div className="absolute bottom-6 left-8 right-8">
            <p className="text-sm font-bold">Fresh dairy, managed beautifully.</p>
            <p className="mt-1 text-xs text-muted-foreground">Stores · Orders · Deliveries · Finance — one console.</p>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

export default Login