/**
 * AnimatedBackground — the ONE looping animation in the app (Home only).
 *
 * Hand-rolled (no deps): the React Bits jsrepo CLI failed to resolve the
 * reactbits.dev Tailwind registry (it returned HTML, not a JSON manifest), so
 * rather than pull in Three.js/GSAP we ship a lightweight, dependency-free
 * aurora drift built from blurred radial-gradient blobs animated via CSS
 * keyframes (compositor-only transforms — cheap on the GPU).
 *
 * Sits BEHIND the Home content: absolute inset-0, -z-10, pointer-events-none.
 * Subtle and dark, using the accent token via inline rgba.
 */
import './aurora.css'

function AnimatedBackground(): JSX.Element {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-bg"
    >
      {/* aurora blobs */}
      <div className="aurora-blob aurora-blob--a" />
      <div className="aurora-blob aurora-blob--b" />
      <div className="aurora-blob aurora-blob--c" />
      {/* vignette to keep edges dark and the center readable */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 120% at 50% 40%, transparent 0%, rgba(14,14,19,0.35) 55%, rgba(14,14,19,0.85) 100%)'
        }}
      />
    </div>
  )
}

export default AnimatedBackground
