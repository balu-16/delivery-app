import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Eye, EyeOff, LogIn, Store, Lock, KeyRound } from 'lucide-react'
import { toast } from '@dairydirect/shared/lib/toast'
import { cn } from '@dairydirect/shared/lib/utils'
import { Button, Input, Label } from '@dairydirect/shared/ui/base'
import { Logo } from '@dairydirect/shared/assets/Logo'
import { LoginHero } from '@dairydirect/shared/assets/scenes'
import { useStoreAuth } from './authStore'

const AUTH_ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: 'Invalid email or password.',
  FORBIDDEN: 'This account cannot sign in to the Store Manager Portal.',
}
function authErrorMessage(error: unknown): string {
  const status = (error as { status?: number }).status ?? 0
  const code = (error as { code?: string }).code
  if (code && AUTH_ERROR_COPY[code]) return AUTH_ERROR_COPY[code]
  if (status === 0) return 'Network problem — check your connection and retry.'
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.'
  return 'Invalid email or password.'
}

export function StoreLoginPage() {
  const status = useStoreAuth((s) => s.status)
  const login = useStoreAuth((s) => s.login)
  const completeFirstLogin = useStoreAuth((s) => s.completeFirstLogin)
  const pendingChallengeId = useStoreAuth((s) => s.pendingChallengeId)
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [shake, setShake] = useState(0)
  const [busy, setBusy] = useState(false)
  const [capsOn, setCapsOn] = useState(false)

  useEffect(() => { document.title = 'Store · Sign in · DairyDirect' }, [])

  const from = (location.state as { from?: string } | null)?.from
  const destination = from && from !== '/login' ? from : '/dashboard'
  if (status === 'authenticated') return <Navigate to={destination} replace />

  const afterAuth = () => {
    toast.success('Welcome back, Store Manager 🏪')
    navigate(destination)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await login(email.trim().toLowerCase(), password, remember)
      if (!res.ok) {
        if (res.challenge) return // challenge stage takes over below
        setError(res.error ?? 'Invalid email or password.')
        setShake((s) => s + 1)
        return
      }
      afterAuth()
    } catch (err) {
      setError(authErrorMessage(err))
      setShake((s) => s + 1)
    } finally {
      setBusy(false)
    }
  }

  const submitChallenge = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword.length < 12 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError('New password needs at least 12 characters with a letter and a digit')
      setShake((s) => s + 1)
      return
    }
    if (confirm !== newPassword) {
      setError('Passwords do not match')
      setShake((s) => s + 1)
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await completeFirstLogin(newPassword)
      if (!res.ok) {
        setError(res.error ?? 'Could not set the new password.')
        setShake((s) => s + 1)
        return
      }
      afterAuth()
    } catch (err) {
      setError(authErrorMessage(err))
      setShake((s) => s + 1)
    } finally {
      setBusy(false)
    }
  }

  const challengeStage = Boolean(pendingChallengeId)

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
          <Logo badge="Store Manager Portal" />
          {/* portal badge pill */}
          <div className="mt-7 inline-flex items-center gap-1.5 rounded-full bg-[#1d4d16] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white">
            <Store className="h-3.5 w-3.5" /> Store Manager Portal
          </div>

          {challengeStage ? (
            <>
              <h1 className="mt-3 text-2xl font-extrabold tracking-tight">Set your new password</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                This is your first sign-in. Choose a new password to activate your account.
              </p>
              <motion.form key={shake} onSubmit={submitChallenge} className="mt-6 space-y-4"
                animate={shake ? { x: [0, -10, 10, -8, 8, -4, 0] } : {}}
                transition={{ duration: 0.4 }}
              >
                <div>
                  <Label htmlFor="npw" required>New password</Label>
                  <div className="relative">
                    <Input id="npw" type={show ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                      onKeyUp={(e) => setCapsOn(e.getModifierState?.('CapsLock') ?? false)}
                      placeholder="••••••••" autoComplete="new-password" />
                    <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Toggle password visibility">
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {capsOn && <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-warning"><Lock className="h-3 w-3" /> Caps Lock is on</p>}
                </div>
                <div>
                  <Label htmlFor="cpw" required>Confirm new password</Label>
                  <Input id="cpw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </div>
                {error && (
                  <p className="flex items-center gap-1.5 rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive" role="alert">
                    <Lock className="h-3.5 w-3.5 shrink-0" /> {error}
                  </p>
                )}
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  <KeyRound className="h-4 w-4" /> {busy ? 'Saving…' : 'Set password and continue'}
                </Button>
              </motion.form>
            </>
          ) : (
            <>
              <h1 className="mt-3 text-2xl font-extrabold tracking-tight">Sign in to the Store Manager Portal</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Run picking, inventory, riders and COD for your assigned store.
              </p>

              <motion.form key={shake} onSubmit={submit} className="mt-6 space-y-4"
                animate={shake ? { x: [0, -10, 10, -8, 8, -4, 0] } : {}}
                transition={{ duration: 0.4 }}
              >
                <div>
                  <Label htmlFor="email" required>Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="manager@dairydirect.in" autoComplete="email" />
                </div>
                <div>
                  <Label htmlFor="password" required>Password</Label>
                  <div className="relative">
                    <Input id="password" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                      onKeyUp={(e) => setCapsOn(e.getModifierState?.('CapsLock') ?? false)}
                      placeholder="••••••••" autoComplete="current-password" />
                    <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Toggle password visibility">
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {capsOn && <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-warning"><Lock className="h-3 w-3" /> Caps Lock is on</p>}
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <label className="flex cursor-pointer items-center gap-2 font-medium text-muted-foreground">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 rounded border-input accent-[#2E7D1A]" />
                    Remember me
                  </label>
                  <button type="button" onClick={() => navigate('/forgot-password')} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
                    Forgot password?
                  </button>
                </div>
                {error && (
                  <p className="flex items-center gap-1.5 rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive" role="alert">
                    <Lock className="h-3.5 w-3.5 shrink-0" /> {error}
                  </p>
                )}
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  <LogIn className="h-4 w-4" /> {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </motion.form>
            </>
          )}
        </div>

        {/* hero — store-manager-themed illustration on the dark-green brand panel */}
        <div className="relative hidden items-center justify-center bg-gradient-to-br from-[#1d4d16] via-[#21581b] to-[#173f12] p-8 lg:flex">
          <div className="rounded-card bg-white/10 p-6 backdrop-blur-sm">
            <LoginHero className="w-full max-w-[420px]" />
          </div>
          <div className="absolute right-8 top-6 grid h-12 w-12 place-items-center rounded-2xl bg-card shadow-lift">
            <Store className="h-6 w-6 text-brand-600" />
          </div>
          <div className="absolute bottom-6 left-8 right-8 text-white">
            <p className="text-sm font-bold">DairyDirect Store Manager Portal</p>
            <p className="mt-1 text-xs text-white/70">Your store, run well — picking, inventory, riders, returns and COD deposits.</p>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
