/**
 * Pure helpers for editing a workspace's split-layout tree when decks are added
 * or deleted. Always return a NEW tree (immutable), renormalizing split sizes.
 */
import type { LayoutNode, PanelId } from '@shared/types'

/** Remove a deck's leaf; collapse single-child splits; null if tree is now empty. */
export function removeLeaf(node: LayoutNode, panelId: PanelId): LayoutNode | null {
  if (node.type === 'leaf') {
    return node.panelId === panelId ? null : node
  }
  const kept: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const pruned = removeLeaf(child, panelId)
    if (pruned) {
      kept.push(pruned)
      sizes.push(node.sizes[i] ?? 1 / node.children.length)
    }
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]
  const sum = sizes.reduce((a, b) => a + b, 0) || 1
  return { type: 'split', direction: node.direction, children: kept, sizes: sizes.map((s) => s / sum) }
}

/** Append a new deck leaf, splitting along `direction` and rebalancing sizes. */
export function addLeaf(
  node: LayoutNode | null,
  panelId: PanelId,
  direction: 'row' | 'column' = 'row'
): LayoutNode {
  const leaf: LayoutNode = { type: 'leaf', panelId }
  if (!node) return leaf
  if (node.type === 'leaf') {
    return { type: 'split', direction, sizes: [0.5, 0.5], children: [node, leaf] }
  }
  // Add to the existing top-level split, sharing space evenly-ish.
  const n = node.children.length
  const scale = n / (n + 1)
  const sizes = node.sizes.map((s) => s * scale)
  sizes.push(1 / (n + 1))
  return { type: 'split', direction: node.direction, children: [...node.children, leaf], sizes }
}
