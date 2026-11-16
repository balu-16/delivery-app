import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home } from 'lucide-react'
import { Button } from '@/components/ui/base'
import { EmptyIllustration } from '@/illustrations/scenes'

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.45 }}>
        <EmptyIllustration kind="cow404" className="h-44" />
      </motion.div>
      <h1 className="text-3xl font-extrabold tracking-tight">404 — Page not found</h1>
      <p className="max-w-sm text-sm text-muted-foreground">Even our cow couldn't graze this page out of the field. Let's head back to the barn.</p>
      <Link to="/dashboard">
        <Button size="lg"><Home className="h-4 w-4" /> Back to Dashboard</Button>
      </Link>
    </div>
  )
}

export default NotFound
