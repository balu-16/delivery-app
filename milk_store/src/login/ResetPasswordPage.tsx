import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { KeyRound } from 'lucide-react'
import { toast } from '@dairydirect/shared/lib/toast'
import { Button, Input, Label } from '@dairydirect/shared/ui/base'
import { Logo } from '@dairydirect/shared/assets/Logo'
import { confirmForgotPassword } from './authApi'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const presetEmail = (location.state as { email?: string } | null)?.email ?? ''
  const [email, setEmail] = useState(presetEmail)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => { document.title = 'Store · Reset password · DairyDirect' }, [])

  const strength = (pw: string) => (pw.length >= 10 && /[A-Z]/.test(pw) && /\d/.test(pw) ? 'Strong' : pw.length >= 8 ? 'Okay' : 'Weak')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Enter a valid email address'
    if (code.trim().length < 6) errs.code = 'Enter the reset code from the email'
    if (password.length < 12) errs.password = 'Minimum 12 characters with a letter and a digit'
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errs.password = 'Must contain a letter and a digit'
    if (confirm !== password) errs.confirm = 'Passwords do not match'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true)
    try {
      await confirmForgotPassword(email.trim().toLowerCase(), code.trim(), password)
      toast.success('Password updated — sign in with your new password')
      navigate('/login')
    } catch (error) {
      const status = (error as { status?: number }).status
      setErrors({
        code: status === 400
          ? 'That code was rejected — check it or request a new one'
          : undefined,
        ...(status === 0 ? { code: 'Network problem — retry in a moment' } : {}),
      } as Record<string, string>)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-bg grid min-h-full place-items-center p-4 sm:p-8">
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="w-full max-w-md rounded-card border border-border bg-card p-8 shadow-lift">
        <Logo badge="Store Manager Portal" />
        <h1 className="mt-6 flex items-center gap-2 text-2xl font-extrabold tracking-tight"><KeyRound className="h-6 w-6 text-brand-600" /> Set new password</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Enter the reset code from your email together with your new password.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="email" required>Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@dairydirect.in" />
            {errors.email && <p className="mt-1 text-xs font-semibold text-destructive">{errors.email}</p>}
          </div>
          <div>
            <Label htmlFor="code" required>Reset code</Label>
            <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 482913" />
            {errors.code && <p className="mt-1 text-xs font-semibold text-destructive">{errors.code}</p>}
          </div>
          <div>
            <Label htmlFor="pw" required>New password</Label>
            <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {password && <p className="mt-1 text-[11px] font-semibold text-muted-foreground">Strength: {strength(password)}</p>}
            {errors.password && <p className="mt-1 text-xs font-semibold text-destructive">{errors.password}</p>}
          </div>
          <div>
            <Label htmlFor="pw2" required>Confirm password</Label>
            <Input id="pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {errors.confirm && <p className="mt-1 text-xs font-semibold text-destructive">{errors.confirm}</p>}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</Button>
        </form>
        <Link to="/login" className="mt-6 block text-center text-[13px] font-semibold text-muted-foreground hover:text-foreground">Back to sign in</Link>
      </motion.div>
    </div>
  )
}
