/**
 * HScroll — a horizontally-scrollable row with faint scroll arrows.
 *
 * Whenever the content overflows, a left/right chevron appears on that side; it's
 * faint by default and brightens on hover, and clicking it scrolls ~80% of a
 * page in that direction. Arrows hide at the respective end. Reusable anywhere a
 * row can scroll sideways.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'

export default function HScroll({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)

  const update = useCallback((): void => {
    const el = ref.current
    if (!el) return
    setAtStart(el.scrollLeft <= 2)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)
  }, [])

  useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [update])

  const by = (dir: 1 | -1): void => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.8), behavior: 'smooth' })
  }

  return (
    <div className="hscroll-wrap">
      {!atStart && (
        <button className="hscroll-arrow left" onClick={() => by(-1)} aria-label="Scroll left">
          <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
      )}
      <div ref={ref} className={`hscroll ${className ?? ''}`}>
        {children}
      </div>
      {!atEnd && (
        <button className="hscroll-arrow right" onClick={() => by(1)} aria-label="Scroll right">
          <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      )}
    </div>
  )
}
