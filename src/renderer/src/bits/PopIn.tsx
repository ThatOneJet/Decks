/**
 * PopIn — a React Bits style spring scale-in (https://reactbits.dev).
 *
 * A small popover/menu enter: scale + fade with a springy ease, anchored from a
 * given transform-origin. Used for the dock app-switcher popover.
 */
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

export default function PopIn({
  children,
  className,
  style,
  origin = 'top left'
}: {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
  /** CSS transform-origin so the pop reads as growing from its anchor. */
  origin?: string
}): JSX.Element {
  return (
    <motion.div
      className={className}
      style={{ transformOrigin: origin, ...style }}
      initial={{ opacity: 0, scale: 0.86, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: -4 }}
      transition={{ type: 'spring', stiffness: 460, damping: 30, mass: 0.7 }}
    >
      {children}
    </motion.div>
  )
}
