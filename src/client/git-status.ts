/**
 * Shared git-status presentation helpers: the status letter of a porcelain
 * XY code and its VSCode-style color classes. Used by the source-control
 * panel (badge pills) and the explorer's SCM-linked decorations (letter +
 * colored file name), so both surfaces always agree on colors.
 */
import css from './sidebar.module.css'

/** The display letter of an XY code (index letter first, then worktree, '?' otherwise). */
export function gitStatusLetter(xy: string): string {
  const index = xy[0]
  const worktree = xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** The pill class of one XY code (M amber, A/U green, D red, R/C blue, ? muted). */
export function gitStatusBadgeClass(xy: string): string | undefined {
  switch (gitStatusLetter(xy)) {
    case 'M': return css.gitBadgeM
    case 'A':
    case 'U': return css.gitBadgeA
    case 'D': return css.gitBadgeD
    case 'R':
    case 'C': return css.gitBadgeR
    default: return css.gitBadgeU
  }
}

/** The explorer file-NAME color class of one XY code (undefined = neutral). */
export function gitStatusNameClass(xy: string): string | undefined {
  switch (gitStatusLetter(xy)) {
    case 'M': return css.explorerGitM
    case 'A':
    case 'U': return css.explorerGitA
    case 'D': return css.explorerGitD
    case 'R':
    case 'C': return css.explorerGitR
    default: return css.explorerGitU
  }
}
