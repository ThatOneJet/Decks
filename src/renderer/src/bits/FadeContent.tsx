/**
 * FadeContent — a React Bits style fade-in wrapper (https://reactbits.dev).
 *
 * Gently fades (and optionally blurs) its children in. Used for the
 * OperationsView loading/error states so they don't pop in harshly.
 */
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

export default function FadeContent({
  children,
  className,
  blur = false,
  duration = 0.45,
  delay = 0
}: {
  children: ReactNode
  className?: string
  /** Animate a small blur → sharp on enter. */
  blur?: boolean
  duration?: number
  delay?: number
}): JSX.Element {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, filter: blur ? 'blur(8px)' : 'blur(0px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}
