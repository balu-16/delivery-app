import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, MailCheck, Send } from 'lucide-react'
import { toast } from '@dairydirect/shared/lib/toast'
import { Button, Input, Label } from '@dairydirect/shared/ui/base'
import { Logo } from '@dairydirect/shared/assets/Logo'
import { forgotPassword } from './authApi'

export function ForgotPasswordPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { document.title = 'Store · Forgot password · DairyDirect' }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email address'); return }
    setBusy(true)
    setError('')
    try {
      await forgotPassword(email.trim().toLowerCase())
      setSent(true)
      toast.success('If the account exists, a reset code is on its way')
    } catch (error) {
      const status = (error as { status?: number }).status
      setError(status === 0
        ? 'Network problem — retry in a moment'
        : 'Something went wrong on our side. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-bg grid min-h-full place-items-center p-4 sm:p-8">
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="w-full max-w-md rounded-card border border-border bg-card p-8 shadow-lift">
        <Logo badge="Store Manager Portal" />
        {!sent ? (
          <>
            <h1 className="mt-6 text-2xl font-extrabold tracking-tight">Forgot password</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">We'll email you a reset code to set a new password.</p>
            <form onSubmit={submit} className="mt-6 space-y-4">
              <div>
                <Label htmlFor="email" required>Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@dairydirect.in" />
                {error && <p className="mt-1 text-xs font-semibold text-destructive">{error}</p>}
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={busy}><Send className="h-4 w-4" /> {busy ? 'Sending…' : 'Continue'}</Button>
            </form>
          </>
        ) : (
          <div className="mt-6 flex flex-col items-center gap-3 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-success-soft text-success"><MailCheck className="h-7 w-7" /></span>
            <h1 className="text-xl font-extrabold tracking-tight">Check your inbox</h1>
            <p className="text-sm text-muted-foreground">A reset code was sent to <b>{email}</b>. Enter it on the next screen to set a new password.</p>
            <Button variant="secondary" className="mt-2" onClick={() => navigate('/reset-password', { state: { email } })}>
              Enter reset code
            </Button>
          </div>
        )}
        <Link to="/login" className="mt-6 flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </Link>
      </motion.div>
    </div>
  )
}
