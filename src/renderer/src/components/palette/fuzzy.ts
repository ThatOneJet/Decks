/**
 * Tiny dependency-free fuzzy matcher for the Cmd+K palette.
 *
 * `fuzzyScore(query, text)` returns null when `query` is not a subsequence of
 * `text` (case-insensitive), otherwise a numeric score where higher is better.
 * Scoring rewards: matches at the start of the string, matches at word
 * boundaries (after a space, '-', '_', '/', '.', or a case change), and runs of
 * contiguous matched characters. An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()

  let score = 0
  let qi = 0
  let prevMatchIdx = -2 // so the first match is never "contiguous"

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue

    let bonus = 1
    if (ti === 0) {
      bonus += 8 // very start of string
    } else {
      const prev = text[ti - 1]
      const isBoundary = /[\s\-_/.]/.test(prev)
      const isCamel = prev === prev.toLowerCase() && text[ti] !== text[ti].toLowerCase()
      if (isBoundary || isCamel) bonus += 6 // start of a word
    }
    if (ti === prevMatchIdx + 1) bonus += 4 // contiguous run

    score += bonus
    prevMatchIdx = ti
    qi++
  }

  // Only a full subsequence match counts.
  if (qi < q.length) return null

  // Prefer shorter targets when scores are otherwise close.
  score -= text.length * 0.05
  return score
}
