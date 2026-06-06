/**
 * Feedback transport token — DO NOT COMMIT A REAL TOKEN.
 *
 * Paste a GitHub fine-grained PAT here LOCALLY to enable the in-app feedback box
 * to file issues on ThatOneJet/Decks. Scope it to ONLY that repository, with
 * permissions: Issues = Read & write, Contents = Read & write (Contents is needed
 * to upload an attached screenshot). Worst case if extracted from the binary:
 * someone can file/edit issues or commit to that one repo — bounded + rotatable.
 *
 * This file is committed with an EMPTY placeholder and marked `skip-worktree`
 * (`git update-index --skip-worktree src/main/feedback-token.ts`) so your local
 * token edit is never staged/committed. The token is baked into the binary you
 * build + distribute; the public source stays clean. You can also override at
 * build time with the DECKS_FEEDBACK_TOKEN env var (takes precedence).
 *
 * Client-side secrets are never truly private — this only bounds the blast radius.
 */
export const FEEDBACK_TOKEN = ''

/** The repo that receives feedback issues. */
export const FEEDBACK_REPO = 'ThatOneJet/Decks'
