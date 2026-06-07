/**
 * AnimatedContent — a React Bits style transition wrapper (https://reactbits.dev).
 *
 * Crossfades + scales its children in when they mount. Used for the top-level
 * Decks ⇄ Operations mode switch (give each mode a stable `key` and wrap the
 * pair in <AnimatePresence> for a smooth crossfade on swap) and anywhere a small
 * enter animation is wanted. No SSR-only APIs — safe in the production build.
 */
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

export default function AnimatedContent({
  children,
  className,
  distance = 0,
  scale = 0.985,
  duration = 0.32,
  delay = 0
}: {
  children: ReactNode
  className?: string
  /** Vertical travel (px) on enter. 0 = pure fade/scale. */
  distance?: number
  /** Initial scale (1 = no scale). */
  scale?: number
  duration?: number
  delay?: number
}): JSX.Element {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: distance, scale }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -distance, scale }}
      transition={{ duration, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
