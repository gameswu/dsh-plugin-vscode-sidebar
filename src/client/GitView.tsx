/**
 * The source-control panel, VSCode-git-style: EVERY discovered repository
 * (the cwd's own + nested checkouts, bounded by the scan-depth setting)
 * renders as its own collapsible section — collapsed by default and fully
 * LAZY (no status/git commands run until the user expands one). Inside a
 * section: staged / unstaged change groups with colored status badges and
 * per-file +/- line counts, an INLINE diff preview per file row, a commit
 * box, branch switch with ahead/behind counts, and a history list drawn as
 * a lane GRAPH (SVG columns, joins and merge-parent slants — see
 * git-graph.ts). The history graph is REMOTE-AWARE like VSCode: commits
 * only reachable from a remote ref render purple, commits on the local
 * branch (or its main spine) render blue, and a synced branch stays an
 * all-blue axis. Clicking a changed file or a history row opens a
 * dedicated diff TAB (see {@link DiffTab}); the chevron on a file row
 * toggles the inline diff instead. Right-click menus carry the advanced
 * operations (open in editor, discard, revert, cherry-pick, copy
 * paths/hashes). Refresh is manual + on mount (no file watcher — KISS).
 */
import { memo, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconBranchOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconCodeOutline16,
  IconCopyOutline16, IconRefreshOutline16, IconTrashOutline16, Input, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitRepoInfo, GitStatusEntry, GitStatusResult, SessionScope } from './api.ts'
import { api } from './api.ts'
import { gitStatusBadgeClass, gitStatusLetter } from './git-status.ts'
import { relativeTo } from './paths.ts'
import { relativeTime, t } from './locales.ts'
import type { SidebarTab } from './state.ts'
import { DiffView } from './DiffView.tsx'
import { emptyGraphState, extendGraph, GRAPH_PALETTE, type GraphRow, type GraphState } from './git-graph.ts'
import css from './sidebar.module.css'

/** Remote-aware history colors (VSCode-like): remote-only purple, local blue. */
const GRAPH_REMOTE_COLOR = '#a371f7'
const GRAPH_LOCAL_COLOR = '#4f8cff'

/** The XY status letters a row badge shows (X = index, Y = worktree). */
const badgeOf = (entry: GitStatusEntry): string => gitStatusLetter(entry.xy)

/** The badge color class per status letter (VSCode-style, shared with the
 *  explorer decorations). */
const badgeClassOf = (entry: GitStatusEntry): string | undefined => gitStatusBadgeClass(entry.xy)

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  const index = entry.xy[0]
  return index !== undefined && index !== ' ' && index !== '?'
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  if (entry.xy === '??') return true
  const worktree = entry.xy[1]
  return worktree !== undefined && worktree !== ' ' && worktree !== '?'
}

/** Whether the entry is untracked (`??`): git diff never includes it. */
function isUntracked(entry: GitStatusEntry): boolean {
  return badgeOf(entry) === '?'
}

/** The last path segment (tab title for a file's diff). */
function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** The display label of one discovered repo: its path relative to the
 *  session cwd (nested checkouts) or its basename (cwd itself / an
 *  enclosing parent repo). */
function repoLabel(root: string, cwd: string | undefined): string {
  const name = baseName(root)
  if (cwd === undefined || cwd === '') return name
  const rel = relativeTo(cwd, root)
  if (rel === '.') return name
  if (rel === root) return name
  return rel
}

/** The ref names of one log row's decorations (`HEAD -> main` → `main`), deduped. */
function refNames(refs: string): string[] {
  return [...new Set(
    refs
      .split(',')
      .map(ref => ref.trim())
      .filter(ref => ref !== '')
      .map(ref => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
      .map(ref => (ref.startsWith('tag: ') ? ref.slice(5) : ref)),
  )]
}

/** Whether one ref name is a REMOTE-tracking ref (origin/* etc.). */
function isRemoteRef(ref: string, remotePrefix: string): boolean {
  return ref.startsWith(remotePrefix) || (ref.includes('/') && ref.startsWith('origin/'))
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm modal. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** The loaded inline diff of one file row (untracked content rendered as a full addition). */
interface InlineDiff {
  key: string
  diff: string
  untrackedPath?: string
  untrackedContent?: string
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 20

// ── History lane graph (SVG) ──────────────────────────────────────────────

/** Graph geometry: column pitch, node radius, row height, lane cap. */
const GRAPH_COL_WIDTH = 12
const GRAPH_NODE_R = 3
const GRAPH_ROW_HEIGHT = 34
const GRAPH_MAX_LANES = 12

/** Center x of a column. */
function graphCx(col: number): number {
  return col * GRAPH_COL_WIDTH + GRAPH_COL_WIDTH / 2 + 2
}

/**
 * The per-row lane glyph: verticals for live lanes, slanted connectors for
 * joins/merge parents, and the commit node — colored per lane like the
 * VSCode git-graph. Columns beyond {@link GRAPH_MAX_LANES} are clipped.
 * `nodeColor` (when present) overrides the node, its column vertical and
 * its outgoing slants — the remote-aware coloring: purple for remote-only
 * commits, blue for the local branch / main spine.
 */
function HistoryGraph({ row, nodeColor }: { row: GraphRow; nodeColor?: string }): ReactNode {
  const laneCount = Math.min(row.lanes.length, GRAPH_MAX_LANES)
  const width = laneCount * GRAPH_COL_WIDTH + 4
  const nodeCol = Math.min(row.col, laneCount - 1)
  const colorOf = (color: number): string => GRAPH_PALETTE[color % GRAPH_PALETTE.length] ?? '#8b949e'
  const slants = row.slants.filter(slant => slant.to < laneCount)
  return (
    <svg className={css.gitGraphSvg} width={width} height={GRAPH_ROW_HEIGHT} aria-hidden="true">
      {row.lanes.map((present, col) => {
        if (!present || col >= laneCount) return null
        return (
          <line
            key={`v${col}`}
            x1={graphCx(col)}
            y1={0}
            x2={graphCx(col)}
            y2={GRAPH_ROW_HEIGHT}
            stroke={nodeColor !== undefined && col === nodeCol ? nodeColor : colorOf(row.colors[col] ?? 0)}
            strokeWidth={1.4}
            opacity={0.8}
          />
        )
      })}
      {slants.map((slant, index) => (
        <path
          key={`s${index}`}
          d={`M ${graphCx(slant.from)} ${GRAPH_ROW_HEIGHT / 2} C ${graphCx(slant.from)} ${GRAPH_ROW_HEIGHT * 0.78}, ${graphCx(slant.to)} ${GRAPH_ROW_HEIGHT * 0.62}, ${graphCx(slant.to)} ${GRAPH_ROW_HEIGHT}`}
          fill="none"
          stroke={nodeColor !== undefined && slant.from === nodeCol ? nodeColor : colorOf(row.colors[slant.to] ?? 0)}
          strokeWidth={1.4}
          opacity={0.8}
        />
      ))}
      <circle
        cx={graphCx(nodeCol)}
        cy={GRAPH_ROW_HEIGHT / 2}
        r={GRAPH_NODE_R}
        fill={nodeColor ?? colorOf(row.colors[nodeCol] ?? 0)}
      />
    </svg>
  )
}

// ── One repository's panel (lazy: mounts only while expanded) ──────────────

/** One history row, memoized on its DATA (entry/graph/color/remote prefix):
 *  a refresh that returns identical rows never re-renders the history list.
 *  The callbacks close over constants (repo root, stable setters), so an
 *  older render's closures stay correct across skipped re-renders. */
const HistoryRow = memo(function HistoryRow(props: {
  entry: GitLogEntry
  graphRow: GraphRow | undefined
  nodeColor: string | undefined
  remotePrefix: string
  onOpen: (entry: GitLogEntry) => void
  onMenu: (event: MouseEvent, entry: GitLogEntry) => void
}) {
  const { entry, graphRow, nodeColor, remotePrefix, onOpen, onMenu } = props
  const refs = refNames(entry.refs)
  return (
    <div
      role="button"
      tabIndex={0}
      className={css.gitLogRow}
      title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
      onClick={() => { onOpen(entry) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(entry)
        }
      }}
      onContextMenu={(event) => { onMenu(event, entry) }}
    >
      {graphRow !== undefined && <HistoryGraph row={graphRow} nodeColor={nodeColor} />}
      <span className={css.gitLogBody}>
        <span className={css.gitLogLine1}>
          <span className={css.gitLogHash}>{entry.hash}</span>
          <span className={css.gitLogSubject}>{entry.subject}</span>
        </span>
        <span className={css.gitLogLine2}>
          {refs.map(ref => (
            <span
              key={ref}
              className={clsx(css.gitLogRef, isRemoteRef(ref, remotePrefix) && css.gitLogRefRemote)}
            >
              {ref}
            </span>
          ))}
          <span className={css.gitLogMeta}>{entry.author} · {relativeTime(entry.date)}</span>
        </span>
      </span>
    </div>
  )
}, (prev, next) =>
  prev.entry === next.entry
  && prev.graphRow === next.graphRow
  && prev.nodeColor === next.nodeColor
  && prev.remotePrefix === next.remotePrefix)

function RepoPanel(props: {
  scope: SessionScope
  root: string
  onOpenFile: (path: string) => void
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { scope, root, onOpenFile, onOpenDiff } = props
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)
  const [inline, setInline] = useState<InlineDiff | null>(null)
  const [inlineLoading, setInlineLoading] = useState(false)
  /** The history lane graph: per-row drawing models + the cross-page state. */
  const [graphRows, setGraphRows] = useState<GraphRow[]>([])
  const graphStateRef = useRef<GraphState>(emptyGraphState())

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [statusResult, branchResult, logResult] = await Promise.all([
        api.gitStatus(scope, root),
        api.gitBranch(scope, root).catch(() => ({ current: '', names: [] as string[] })),
        // The first history page only; the rest arrives via "load more".
        api.gitLog(scope, LOG_BATCH, 0, root).catch(() => [] as GitLogEntry[]),
      ])
      setStatus(statusResult)
      setBranchNames(branchResult.names)
      setLogEntries(logResult)
      setLogEnded(logResult.length < LOG_BATCH)
      // Rebuild the lane graph from a fresh state (branch may differ).
      const extended = extendGraph(emptyGraphState(), logResult)
      graphStateRef.current = extended.state
      setGraphRows(extended.rows)
      // A stale inline diff (refresh) is dropped with its rows.
      setInline(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [scope.sessionId, scope.cwd, root])

  useEffect(() => { void refresh() }, [refresh])

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    setLogLoadingMore(true)
    try {
      const next = await api.gitLog(scope, LOG_BATCH, logEntries.length, root)
      setLogEntries(entries => [...entries, ...next])
      // Continue the lane graph across the page boundary: the previous
      // page's tips seed the next one, keeping columns and colors stable.
      const extended = extendGraph(graphStateRef.current, next)
      graphStateRef.current = extended.state
      setGraphRows(rows => [...rows, ...extended.rows])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      setCommitError(`${t('historyLoadError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setLogLoadingMore(false)
    }
  }

  /** The diff tab for one changed file (one tab per path+side; same id = focused). */
  const openWorktreeDiff = (entry: GitStatusEntry, staged: boolean): void => {
    onOpenDiff({
      id: `diff:w:${staged ? 's' : 'u'}:${entry.path}`,
      type: 'diff',
      title: baseName(entry.path),
      diff: {
        kind: 'worktree',
        path: entry.path,
        staged,
        untracked: isUntracked(entry),
        repo: root,
      },
    })
  }

  /** The diff tab for one commit (one tab per commit). */
  const openCommitDiff = (entry: GitLogEntry): void => {
    onOpenDiff({
      id: `diff:c:${entry.hashFull}`,
      type: 'diff',
      title: `${entry.hash} ${entry.subject}`,
      diff: { kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject, repo: root },
    })
  }

  /** Toggle the inline diff of one file row: fetch the unified diff (or the
   *  untracked file content) once, then render it inline under the row. */
  const toggleInline = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    const key = `${staged ? 's' : 'u'}:${entry.path}`
    if (inline?.key === key) {
      setInline(null)
      return
    }
    setInline(null)
    setInlineLoading(true)
    setCommitError(null)
    try {
      let result = await api.gitDiff(scope, entry.path, staged, root)
      if (result.diff === '') {
        // The requested side is empty — try the OTHER side once (the change
        // may have moved across staging since the list refreshed).
        const other = await api.gitDiff(scope, entry.path, !staged, root)
        if (other.diff !== '') result = other
      }
      if (result.diff !== '') {
        setInline({ key, diff: result.diff })
        return
      }
      // Empty diff: an untracked file renders as a full-file addition.
      if (isUntracked(entry) && !staged) {
        const text = await api.fsRead(scope, entry.absPath ?? entry.path, root)
        setInline({
          key,
          diff: '',
          untrackedPath: entry.path,
          untrackedContent: text.kind === 'text' ? text.content : '',
        })
        return
      }
      setInline({ key, diff: '' })
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setInlineLoading(false)
    }
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, entry.path, root)
      else await api.gitStage(scope, entry.path, root)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, undefined, root)
      else await api.gitStage(scope, undefined, root)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCommit(scope, message, root)
      setCommitMsg('')
      await refresh()
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === status?.branch || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCheckout(scope, branch, root)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Run one destructive operation after the confirm modal, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm({ ...confirmState, onConfirm: async () => {
      setBusy(true)
      setCommitError(null)
      try {
        await confirmState.onConfirm()
        await refresh()
      } catch (reason) {
        setCommitError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    } })
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }

  const openHistoryMenu = (event: MouseEvent, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const stagedEntries = (status?.entries ?? []).filter(isStagedEntry)
  const unstagedEntries = (status?.entries ?? []).filter(isUnstagedEntry)
  const aheadBehind = status?.aheadBehind ?? null

  // ── Remote-aware history coloring (VSCode-style) ─────────────────────────
  const localBranch = status?.branch ?? ''
  const upstream = aheadBehind?.upstream ?? ''
  const remotePrefix = upstream.includes('/') ? `${upstream.slice(0, upstream.indexOf('/'))}/` : 'origin/'
  /** The node color of one history row: remote-only → purple, local/spine → blue. */
  const nodeColorOf = (entry: GitLogEntry, graphRow: GraphRow | undefined): string | undefined => {
    const refs = refNames(entry.refs)
    const remote = refs.some(ref => isRemoteRef(ref, remotePrefix))
    const local = refs.some(ref => ref === localBranch || ref === 'HEAD')
    if (remote && !local) return GRAPH_REMOTE_COLOR
    if (local) return GRAPH_LOCAL_COLOR
    // Unlabelled commits on the MAIN spine (lane 0) belong to the local
    // branch's ancestry — keep the all-blue axis VSCode shows in sync.
    if (graphRow !== undefined && graphRow.col === 0) return GRAPH_LOCAL_COLOR
    return undefined
  }

  /** The +a / −d line counts of one row (absent for untracked/binary). */
  const rowCounts = (entry: GitStatusEntry): ReactNode => {
    if (entry.added === undefined && entry.deleted === undefined) return null
    return (
      <span className={css.gitRowCounts}>
        {entry.added !== null && entry.added !== undefined && entry.added > 0 && (
          <span className={css.gitRowAdded}>+{entry.added}</span>
        )}
        {entry.deleted !== null && entry.deleted !== undefined && entry.deleted > 0 && (
          <span className={css.gitRowDeleted}>−{entry.deleted}</span>
        )}
      </span>
    )
  }

  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => {
    const key = `${staged ? 's' : 'u'}:${entry.path}`
    const expanded = inline?.key === key
    return (
      <div key={key}>
        <div className={css.gitRow}>
          <button
            type="button"
            className={clsx(css.gitExpandBtn, expanded && css.gitExpandBtnOpen)}
            aria-label={expanded ? t('gitHideDiff') : t('gitShowDiff')}
            title={expanded ? t('gitHideDiff') : t('gitShowDiff')}
            disabled={inlineLoading}
            onClick={(event) => {
              event.stopPropagation()
              void toggleInline(entry, staged)
            }}
          >
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </button>
          <button
            type="button"
            className={css.gitRowMain}
            title={entry.absPath ?? entry.path}
            onClick={() => { openWorktreeDiff(entry, staged) }}
            onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
          >
            <span className={clsx(css.gitBadge, badgeClassOf(entry))}>{badgeOf(entry)}</span>
            <span className={css.gitName}>{entry.path}</span>
            {rowCounts(entry)}
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={staged ? t('unstage') : t('stage')}
            title={staged ? t('unstage') : t('stage')}
            disabled={busy}
            onClick={() => { void stageEntry(entry, staged) }}
          >
            {staged ? <IconTrashOutline16 /> : <IconBranchOutline16 />}
          </button>
        </div>
        {expanded && (
          <div className={css.gitInlineDiff}>
            {inlineLoading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
            {!inlineLoading && inline !== null && inline.diff === '' && inline.untrackedPath === undefined && (
              <div className={css.gitEmpty}>{t('diffEmpty')}</div>
            )}
            {!inlineLoading && inline !== null && (
              <DiffView
                diff={inline.diff}
                untrackedPath={inline.untrackedPath}
                untrackedContent={inline.untrackedContent}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={css.gitRepoPanel}>
      <div className={css.gitHeader}>
        <select
          className={css.gitBranchSelect}
          value={status?.branch ?? ''}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || (status !== null && !status.isRepo)}
        >
          {(status?.branch ?? '') !== '' && <option value={status!.branch}>{status!.branch}</option>}
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        {aheadBehind !== null && (
          <span
            className={css.gitAheadBehind}
            title={`${t('gitAheadBehind', { ahead: aheadBehind.ahead, behind: aheadBehind.behind })} (${aheadBehind.upstream})`}
          >
            <span className={css.gitAhead}>↑{aheadBehind.ahead}</span>
            <span className={css.gitBehind}>↓{aheadBehind.behind}</span>
          </span>
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline16 />
        </button>
      </div>

      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{error}</div>}
      {!loading && status !== null && !status.isRepo && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}

      {status !== null && status.isRepo && (
        <>
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('staged')} ({stagedEntries.length})</span>
              {stagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(true) }}>
                  {t('unstageAll')}
                </button>
              )}
            </div>
            {stagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {stagedEntries.map(entry => renderEntry(entry, true))}
          </div>
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('unstaged')} ({unstagedEntries.length})</span>
              {unstagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(false) }}>
                  {t('stageAll')}
                </button>
              )}
            </div>
            {unstagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {unstagedEntries.map(entry => renderEntry(entry, false))}
          </div>

          <div className={css.gitCommit}>
            <Input
              className={css.gitCommitInput}
              placeholder={t('commitPlaceholder')}
              value={commitMsg}
              disabled={busy}
              onChange={(event) => { setCommitMsg(event.target.value); setCommitError(null) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
              }}
            />
            <button
              type="button"
              className={css.gitCommitButton}
              disabled={busy || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={() => { void commit() }}
            >
              {t('commit')}
            </button>
          </div>
          {commitError !== null && <div className={css.gitError}>{commitError}</div>}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}><span>{t('history')}</span></div>
            {logEntries.map((entry, index) => {
              const graphRow: GraphRow | undefined = graphRows[index]
              return (
                <HistoryRow
                  key={entry.hashFull}
                  entry={entry}
                  graphRow={graphRow}
                  nodeColor={nodeColorOf(entry, graphRow)}
                  remotePrefix={remotePrefix}
                  onOpen={openCommitDiff}
                  onMenu={openHistoryMenu}
                />
              )
            })}
            {!logEnded && (
              <button
                type="button"
                className={css.gitLogMore}
                disabled={logLoadingMore || busy}
                onClick={() => { void loadMoreLog() }}
              >
                {logLoadingMore ? t('loading') : t('loadMore')}
              </button>
            )}
          </div>

          {/*
            The one shared file-row context menu, positioned at the right-click
            cursor (portal so the panel's overflow clip cannot crop it).
          */}
          <Menu
            open={fileMenu !== null}
            onClose={() => { setFileMenu(null) }}
            items={[
              { id: 'open', label: t('openEditor'), icon: <IconCodeOutline16 size={14} /> },
              fileMenu?.staged === true
                ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutline16 size={14} /> }
                : { id: 'stage', label: t('stage'), icon: <IconBranchOutline16 size={14} /> },
              ...(fileMenu !== null && !isUntracked(fileMenu.entry)
                ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutline16 size={14} />, danger: true }]
                : []),
              { type: 'separator', id: 'sep1' },
              { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
            ]}
            onSelect={(id) => {
              const target = fileMenu
              if (target === null) return
              setFileMenu(null)
              if (id === 'open') {
                onOpenFile(target.entry.absPath ?? target.entry.path)
                return
              }
              if (id === 'stage') {
                void stageEntry(target.entry, target.staged)
                return
              }
              if (id === 'discard') {
                runConfirmed({
                  title: t('discardTitle'),
                  description: t('discardDesc', { path: target.entry.path }),
                  confirmLabel: t('discard'),
                  onConfirm: () => api.gitDiscard(scope, target.entry.absPath ?? target.entry.path, root),
                })
                return
              }
              if (id === 'relative') {
                copy(relativeTo(scope.cwd ?? '', target.entry.absPath ?? target.entry.path))
                return
              }
              if (id === 'absolute') copy(target.entry.absPath ?? target.entry.path)
            }}
            portal
            align="start"
            getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* The shared history-row context menu. */}
          <Menu
            open={historyMenu !== null}
            onClose={() => { setHistoryMenu(null) }}
            items={[
              { id: 'view', label: t('viewCommitDiff') },
              { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutline16 size={14} /> },
              { type: 'separator', id: 'sep2' },
              { id: 'revert', label: t('revertCommit'), danger: true },
              { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
            ]}
            onSelect={(id) => {
              const target = historyMenu
              if (target === null) return
              setHistoryMenu(null)
              if (id === 'view') {
                openCommitDiff(target.entry)
                return
              }
              if (id === 'copyShort') {
                copy(target.entry.hash)
                return
              }
              if (id === 'copyFull') {
                copy(target.entry.hashFull)
                return
              }
              if (id === 'copySubject') {
                copy(target.entry.subject)
                return
              }
              if (id === 'revert') {
                runConfirmed({
                  title: t('revertTitle'),
                  description: t('revertDesc', { subject: target.entry.subject }),
                  confirmLabel: t('revertCommit'),
                  onConfirm: () => api.gitRevert(scope, target.entry.hashFull, root),
                })
                return
              }
              if (id === 'cherryPick') {
                runConfirmed({
                  title: t('cherryPickTitle'),
                  description: t('cherryPickDesc', { subject: target.entry.subject }),
                  confirmLabel: t('cherryPickCommit'),
                  onConfirm: () => api.gitCherryPick(scope, target.entry.hashFull, root),
                })
              }
            }}
            portal
            align="start"
            getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* Destructive actions land here first: Cancel / Confirm. */}
          <Modal
            open={confirm !== null}
            onClose={() => { setConfirm(null) }}
            title={confirm?.title ?? ''}
            closeLabel={t('cancel')}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const pending = confirm
                    if (pending === null) return
                    setConfirm(null)
                    void pending.onConfirm()
                  }}
                >
                  {confirm?.confirmLabel ?? ''}
                </Button>
              </>
            )}
          >
            <p className={css.gitConfirmDesc}>{confirm?.description}</p>
          </Modal>
        </>
      )}
    </div>
  )
}

// ── The multi-repo source-control view ─────────────────────────────────────

export function GitView(props: {
  scope: SessionScope
  onOpenFile: (path: string) => void
  /** Open a diff tab (the shell places it below the git pane on first use). */
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { scope, onOpenFile, onOpenDiff } = props
  const [repos, setRepos] = useState<GitRepoInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The expanded repo roots (default ALL collapsed: no status computed). */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refresh = useCallback(async (force = false): Promise<void> => {
    setError(null)
    try {
      const result = await api.gitRepos(scope, force)
      setRepos(result.repos)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void refresh() }, [refresh])

  const toggleRepo = (root: string): void => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  }

  return (
    <div className={css.git}>
      <div className={css.gitHeader}>
        <span className={css.gitReposTitle}>{t('git')}</span>
        {repos !== null && <span className={css.gitReposCount}>{t('gitReposCount', { count: repos.length })}</span>}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh(true) }}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      {repos === null && error === null && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {error !== null && <div className={css.gitError}>{error}</div>}
      {repos !== null && repos.length === 0 && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}
      {repos?.map(repoInfo => {
        const open = expanded.has(repoInfo.root)
        return (
          <div key={repoInfo.root} className={css.gitRepoSection}>
            <button
              type="button"
              className={clsx(css.gitRepoHeader, open && css.gitRepoHeaderOpen)}
              aria-expanded={open}
              onClick={() => { toggleRepo(repoInfo.root) }}
            >
              {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
              <span className={css.gitRepoLabel} title={repoInfo.root}>{repoLabel(repoInfo.root, scope.cwd)}</span>
              {repoInfo.branch !== undefined && repoInfo.branch !== '' && (
                <span className={css.gitRepoBranch}>
                  <IconBranchOutline16 size={12} />
                  {repoInfo.branch}
                </span>
              )}
            </button>
            {open && (
              <RepoPanel
                scope={scope}
                root={repoInfo.root}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
