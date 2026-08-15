/**
 * Subagent page: the FULL agent topology of the current tree's main session.
 *
 * The root is resolved by walking the durable parent chain upward from the
 * current session to the first non-subagent session — the MAIN session — and
 * every subagent under it shares this one topology view, no matter how deep
 * the current selection is (including a subagent transcript opened in the
 * main view). The main agent renders as the root node card (click it to jump
 * back to the main session), with its subagents hanging below it in clearly
 * LAYERED levels: tree connector lines (first level included) and per-level
 * indentation show the hierarchy, and the currently-open session is
 * highlighted in place. Every branch is expanded automatically (lazy
 * catalogs hydrate on demand and consume live membership while visible).
 *
 * Each node card carries live status (state dot, durable label, mode and
 * activity); while a child RUNS, its card additionally shows the LAST text
 * output and LAST tool call pulled from its history tail, auto-refreshing
 * every few seconds while the page is visible. Clicking a card jumps
 * straight into the child transcript (`openSubagent`); the page stays open
 * and the topology remains rooted at the main session.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconRefreshOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Context,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentAddress,
  SidebarSubagentCatalog,
  SidebarSubagentChildEntry,
  SidebarSubagentDiagnosticEntry,
  SidebarJobView,
} from '../context-types.ts'
import {
  collectBranchIds,
  countSubagentDescendants,
  rootAncestor,
} from './subagent-detect.ts'
import { lastActivity } from './subagent-activity.ts'
import {
  collectTreeJobs,
  formatJobDuration,
  isJobLive,
  orderJobs,
  jobDotState,
  jobStatusLabel,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, type JobOutputResult } from './api.ts'
import { IconStopOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import type { SidebarPrefs } from '../prefs-shared.ts'
import css from './SubagentView.module.css'

/** Refresh cadence of the live "last text + tool call" lines while a child runs. */
const POLL_MS = 3000
/** Preview cap of one tool-call argument line. */
const ARGS_PREVIEW = 60
/** Refresh cadence of an expanded job-output panel while its job runs. */
const JOB_POLL_MS = 2000
/** How long the kill button stays armed before it needs re-confirming. */
const JOB_KILL_ARM_MS = 3000

/** The direct subagent children of one parent (durable `origin` rows). */
function directChildren(
  byId: Readonly<Record<string, SidebarSessionSummary>>,
  parentSessionId: string,
): SidebarSessionSummary[] {
  return Object.values(byId).filter(
    summary => summary.origin === 'subagent' && summary.parentId === parentSessionId,
  )
}

/** Human label of one catalog child: durable label, then summary title, then id. */
function childLabel(
  entry: SidebarSubagentChildEntry,
  summary: SidebarSessionSummary | undefined,
): string {
  return entry.label ?? summary?.displayTitle ?? entry.id
}

function diagnosticReason(entry: SidebarSubagentDiagnosticEntry): string {
  switch (entry.reason) {
    case 'corrupt': return t('subagentDiagCorrupt')
    case 'unsupported': return t('subagentDiagUnsupported')
    case 'unavailable': return t('subagentDiagUnavailable')
  }
}

/** The secondary line of one card: title · mode · activity (skips empty parts). */
function cardSecondary(
  summary: SidebarSessionSummary | undefined,
  entry: SidebarSubagentChildEntry,
): string {
  return [
    summary?.displayTitle,
    entry.mode === 'one-shot' ? t('subagentModeOneShot') : t('subagentModeContinuable'),
    entry.activity === 'running' ? t('subagentRunning') : t('subagentInactive'),
  ].filter(Boolean).join(' · ')
}

/** First `limit` characters with an ellipsis when truncated. */
function preview(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Collapse whitespace for the single-paragraph live-text preview. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Disabled "loading…" cards backed by the summary mirror while a catalog hydrates. */
function CatalogLoadingRows(props: {
  parentSessionId: string
  byId: Readonly<Record<string, SidebarSessionSummary>>
  level: number
}) {
  const { parentSessionId, byId, level } = props
  const children = directChildren(byId, parentSessionId)
  if (children.length === 0) {
    return <div className={css.subagentEmpty}>{t('loading')}</div>
  }
  return (
    <>
      {children.map(summary => (
        <div
          key={summary.id}
          role="treeitem"
          aria-disabled="true"
          aria-level={level}
          aria-label={t('loading')}
          className={`${css.subagentRow} ${css.subagentRowDisabled} ${css.subagentRowLoading}`}
        >
          <StateDot state={summary.running === true ? 'ongoing' : 'done'} className={css.subagentDot} />
          <span className={css.subagentContent}>
            <span className={css.subagentLabel}>{t('loading')}</span>
          </span>
        </div>
      ))}
    </>
  )
}

/**
 * The live lines of one RUNNING subagent card: the last text output and the
 * last tool call of the child's history tail, refreshed every few seconds
 * while the page is visible. Idle cards render nothing (a quiet topology); a
 * running child with neither output yet reads "thinking…".
 */
function SubagentLiveLines(props: {
  ctx: Context
  parentSessionId: string
  childSessionId: string
  mode: SidebarSubagentAddress['mode']
  running: boolean
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
}) {
  const { ctx, parentSessionId, childSessionId, mode, running, active } = props
  const [live, setLive] = useState<ReturnType<typeof lastActivity>>({})
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const address = useMemo(
    () => ({ parentSessionId, childSessionId, mode }),
    [parentSessionId, childSessionId, mode],
  )

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const response = await ctx.connection.api.subagents.history(
        { ...address, maxMessages: 12 },
        controller.signal,
      )
      if (!response.result.ok) return
      setLive(lastActivity(response.result.value.events))
    } catch {
      // Aborted by a newer pull or a wire failure: keep the last known lines.
    }
  }, [ctx, address])

  useEffect(() => {
    if (!active) return
    void load()
    if (!running) return
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [load, running, active])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  if (!running) return null
  if (live.text === undefined && live.tool === undefined) {
    return <span className={css.subagentLive}>{t('subagentThinking')}</span>
  }
  return (
    <>
      {live.tool !== undefined && (
        <span className={css.subagentLive}>
          <span className={css.subagentLiveTool}>{live.tool.name}</span>
          {live.tool.args !== '' && (
            <span className={css.subagentLiveArgs}>{preview(live.tool.args, ARGS_PREVIEW)}</span>
          )}
        </span>
      )}
      {live.text !== undefined && (
        <span className={css.subagentLiveText}>{flatten(live.text)}</span>
      )}
    </>
  )
}

interface RowsProps {
  parentSessionId: string
  catalog: SidebarSubagentCatalog | undefined
  catalogs: Readonly<Record<string, SidebarSubagentCatalog>>
  byId: Readonly<Record<string, SidebarSessionSummary>>
  level: number
  /** The currently-open session id (highlighted in the topology). */
  currentSessionId: string
  /** The page is visible (active tab + open panel): live polling pauses otherwise. */
  active: boolean
  ctx: Context
  openChild: (address: SidebarSubagentAddress) => void
  refresh: (parentSessionId: string) => void
}

/** Render one topology level; branches are always expanded (lazy catalogs). */
function CatalogRows({
  parentSessionId, catalog, catalogs, byId, level, currentSessionId, active, ctx,
  openChild, refresh,
}: RowsProps) {
  const emptyLoading = catalog?.state === 'loading' && catalog.entries.length === 0
  return (
    <>
      {emptyLoading && (
        <CatalogLoadingRows parentSessionId={parentSessionId} byId={byId} level={level} />
      )}
      {catalog?.state === 'error' && (
        <div className={css.subagentError}>
          <span>{catalog.error?.message ?? t('error')}</span>
          <button
            type="button"
            className={css.subagentErrorRetry}
            onClick={() => { refresh(parentSessionId) }}
          >
            <IconRefreshOutline14 />
            {t('retry')}
          </button>
        </div>
      )}
      {(catalog?.entries ?? []).map((entry) => {
        if (entry.kind === 'diagnostic') {
          return (
            <div key={entry.id} className={css.subagentNode}>
              <div
                role="treeitem"
                aria-disabled="true"
                aria-level={level}
                className={`${css.subagentRow} ${css.subagentRowDisabled}`}
                title={diagnosticReason(entry)}
              >
                <StateDot state="error" className={css.subagentDot} />
                <span className={css.subagentContent}>
                  <span className={css.subagentLabel}>{entry.id}</span>
                  <span className={css.subagentSecondary}>{diagnosticReason(entry)}</span>
                </span>
              </div>
            </div>
          )
        }

        const childCatalog = catalogs[entry.id]
        const knownLeaf = !entry.hasChildren
        const summary = byId[entry.id]
        const label = childLabel(entry, summary)
        const secondary = cardSecondary(summary, entry)
        const childLoading = childCatalog === undefined
          || (childCatalog.state === 'loading' && childCatalog.entries.length === 0)
        const address: SidebarSubagentAddress = {
          parentSessionId,
          childSessionId: entry.id,
          mode: entry.mode,
        }
        const current = entry.id === currentSessionId

        return (
          <div key={entry.id} className={css.subagentNode}>
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={level}
              aria-label={`${label} ${secondary}`}
              aria-current={current ? 'true' : undefined}
              {...knownLeaf ? {} : { 'aria-expanded': true }}
              className={clsx(css.subagentRow, current && css.subagentRowActive)}
              onClick={() => { openChild(address) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  openChild(address)
                }
              }}
            >
              <StateDot
                state={entry.activity === 'running' ? 'ongoing' : 'done'}
                className={css.subagentDot}
              />
              <span className={css.subagentContent}>
                <span className={css.subagentLabel}>{label}</span>
                <span className={css.subagentSecondary}>{secondary}</span>
                <SubagentLiveLines
                  ctx={ctx}
                  parentSessionId={parentSessionId}
                  childSessionId={entry.id}
                  mode={entry.mode}
                  running={entry.activity === 'running'}
                  active={active}
                />
              </span>
            </div>
            {!knownLeaf && (
              <div role="group" className={css.subagentChildren} aria-busy={childLoading || undefined}>
                {childCatalog === undefined
                  ? (
                    <CatalogLoadingRows
                      parentSessionId={entry.id}
                      byId={byId}
                      level={level + 1}
                    />
                  )
                  : (
                    <CatalogRows
                      parentSessionId={entry.id}
                      catalog={childCatalog}
                      catalogs={catalogs}
                      byId={byId}
                      level={level + 1}
                      currentSessionId={currentSessionId}
                      active={active}
                      ctx={ctx}
                      openChild={openChild}
                      refresh={refresh}
                    />
                  )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * The inline TERMINAL of one expanded job row: a dark, monospace surface
 * that streams the job's output as the MODEL has read it so far (replayed
 * from the owner session's event log — the model's `job_output` cursor is
 * never touched), refreshed every {@link JOB_POLL_MS} while the job runs
 * and the page is visible. Terminal behavior: the view pins to the newest
 * output while the job runs (a blinking block cursor marks the tail); when
 * the reader scrolls up, pinning pauses and a "follow latest" chip offers
 * to re-pin. Only the CLICKED row mounts this panel — unselected rows stay
 * as compact thumbnails.
 */
function JobTerminal(props: {
  ownerSessionId: string
  job: SidebarJobView
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
  onCollapse: () => void
}) {
  const { ownerSessionId, job, active, onCollapse } = props
  const [state, setState] = useState<'loading' | JobOutputResult | 'error'>('loading')
  const [pinned, setPinned] = useState(true)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const preRef = useRef<HTMLPreElement>(null)
  const live = isJobLive(job)

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const result = await api.jobOutput({ sessionId: ownerSessionId }, job.id, controller.signal)
      setState(result)
    } catch {
      // A newer pull aborted this one, or the wire failed: keep the last
      // known output; only a terminal that never loaded anything shows an error.
      setState(current => (current === 'loading' ? 'error' : current))
    }
  }, [ownerSessionId, job.id])

  useEffect(() => {
    void load()
    if (!active || !live) return
    const timer = window.setInterval(() => { void load() }, JOB_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [load, active, job.status])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // Terminal-tail behavior: while the job runs and the reader has not
  // scrolled away, every refresh pins the view to the newest output.
  useEffect(() => {
    if (!live || !pinned || typeof state !== 'object' || state.text.length === 0) return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
  }, [state, job.status, live, pinned])

  const onScroll = (): void => {
    const pre = preRef.current
    if (pre === null) return
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8
    setPinned(nearBottom)
  }

  const follow = (): void => {
    setPinned(true)
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
  }

  return (
    <div className={css.jobTerminal} role="region" aria-label={`${job.label} ${t('jobs')}`}>
      <div className={css.jobTerminalHeader}>
        <StateDot state={jobDotState(job.status)} className={css.jobTerminalDot} />
        <span className={css.jobTerminalLabel} title={job.label}>{job.label}</span>
        <span className={css.jobTerminalStatus}>
          {jobStatusLabel(job.status, t)}
          {job.detail !== undefined && job.detail !== '' ? ` · ${job.detail}` : ''}
        </span>
        <button
          type="button"
          className={css.jobTerminalClose}
          aria-label={t('close')}
          title={t('close')}
          onClick={onCollapse}
        >
          <IconStopOutline16 size={10} />
        </button>
      </div>
      {state === 'loading' && <div className={css.jobTerminalHint}>{t('loading')}</div>}
      {state === 'error' && (
        <div className={`${css.jobTerminalHint} ${css.jobTerminalError}`}>{t('jobOutputError')}</div>
      )}
      {typeof state === 'object' && (
        <div className={css.jobTerminalBody}>
          {state.text.length > 0
            ? (
              <pre ref={preRef} className={css.jobTerminalPre} onScroll={onScroll}>
                {state.text}
                {live && <span className={css.jobTerminalCursor} aria-hidden="true">▍</span>}
              </pre>
            )
            : state.read
              ? <div className={css.jobTerminalHint}>{t('jobNoOutput')}</div>
              : <div className={css.jobTerminalHint}>{t('jobNotReadYet')}</div>}
          {state.truncated && <div className={css.jobTerminalHint}>{t('jobOutputTruncated')}</div>}
          {live && !pinned && state.text.length > 0 && (
            <button type="button" className={css.jobTerminalFollow} onClick={follow}>
              {t('jobFollowOutput')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The background-job section of the Subagent page: every job of the whole
 * current tree (main agent + subagents, owner-labeled), fed by the harness
 * `session/jobs` push mirror. Rows render as compact thumbnails (status dot,
 * label, owner, duration); clicking a row EXPANDS an inline terminal under
 * that card that streams its model-read output (event replay — never the
 * model's cursor) until collapsed or another row is clicked. Live rows
 * carry a two-click-confirm kill button. Renders nothing while the tree has
 * no jobs.
 */
function JobsSection(props: {
  byId: SidebarSessionList['byId']
  jobsBySession: SidebarSessionList['jobsBySession']
  rootId: string | undefined
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
  /** Auto-expand the streaming output of a NEW live job (the autoOpenJobStream pref). */
  autoExpandStream: boolean
}) {
  const { byId, jobsBySession, rootId, active, autoExpandStream } = props
  const rows = useMemo(
    () => orderJobs(collectTreeJobs(byId, jobsBySession, rootId)),
    [byId, jobsBySession, rootId],
  )
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  const [killingId, setKillingId] = useState<string | undefined>(undefined)
  const [killErrorId, setKillErrorId] = useState<string | undefined>(undefined)
  // The duration clock only runs while a live row is on screen.
  const [now, setNow] = useState(() => Date.now())

  const selectedRow = useMemo(
    () => (selectedId === undefined ? undefined : rows.find(row => row.job.id === selectedId)),
    [rows, selectedId],
  )

  // Auto-expand (autoOpenJobStream): the first LIVE job id this snapshot
  // lacks expands its streaming output without a click. Fires on page open
  // too (an already-running job expands so its output is immediately
  // visible) — the pref is exactly "open the page and watch the stream".
  const liveIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const liveIds = new Set(rows.filter(row => isJobLive(row.job)).map(row => row.job.id))
    const prev = liveIdsRef.current
    liveIdsRef.current = liveIds
    if (!autoExpandStream) return
    for (const id of liveIds) {
      if (!prev.has(id)) {
        setSelectedId(id)
        return
      }
    }
  }, [rows, autoExpandStream])

  const liveCount = useMemo(
    () => rows.reduce((count, row) => count + (isJobLive(row.job) ? 1 : 0), 0),
    [rows],
  )
  const multiOwner = useMemo(
    () => new Set(rows.map(row => row.ownerSessionId)).size > 1,
    [rows],
  )

  // The kill button stays armed only briefly; a stray click must never kill.
  useEffect(() => {
    if (armedId === undefined) return
    const timer = window.setTimeout(() => { setArmedId(undefined) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armedId])

  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [liveCount])

  // The docked output pane follows its job: when the selected job leaves
  // the mirror (settled and dropped, or the tree switched), close the dock.
  useEffect(() => {
    if (selectedId !== undefined && selectedRow === undefined) setSelectedId(undefined)
  }, [selectedId, selectedRow])

  // NOTE: every hook must live ABOVE the empty-state return — a hook below it
  // would flip this component's hook count when the mirror empties and crash
  // React with "Rendered fewer hooks than expected" (the #300 regression).
  const kill = useCallback(async (row: TreeJob): Promise<void> => {
    setKillingId(row.job.id)
    setKillErrorId(undefined)
    try {
      await api.jobKill({ sessionId: row.ownerSessionId }, row.job.id)
    } catch {
      setKillErrorId(row.job.id)
    } finally {
      setKillingId(undefined)
      setArmedId(undefined)
    }
  }, [])

  if (rows.length === 0) return null

  const countLabel = liveCount > 0
    ? t('jobsCountRunning', { count: rows.length, running: liveCount })
    : t('jobsCount', { count: rows.length })

  return (
    <>
      <section className={css.jobs} aria-label={t('jobs')}>
        <div className={css.jobsHeader}>
          <span className={css.jobsTitle}>{t('jobs')}</span>
          <span className={css.jobsCount}>{countLabel}</span>
        </div>
        <ul className={css.jobsList} aria-label={t('jobs')}>
          {rows.map((row) => {
            const { job } = row
            const live = isJobLive(job)
            const selected = selectedId === job.id
            const armed = armedId === job.id
            const killing = killingId === job.id
            const killFailed = killErrorId === job.id
            const elapsed = live
              ? now - job.startedAt
              : (job.finishedAt ?? job.startedAt) - job.startedAt
            const secondary = [
              ...(multiOwner ? [row.ownerTitle] : []),
              jobStatusLabel(job.status, t),
              ...(job.detail !== undefined && job.detail !== '' ? [job.detail] : []),
              formatJobDuration(elapsed, t),
            ].filter(Boolean).join(' · ')
            return (
              <li
                key={job.id}
                className={clsx(
                  css.jobsRow,
                  !live && css.jobsRowSettled,
                  selected && css.jobsRowSelected,
                )}
              >
                <div className={css.jobsRowLine}>
                  <button
                    type="button"
                    className={css.jobsRowMain}
                    aria-pressed={selected}
                    aria-label={`${job.label} ${secondary}`}
                    onClick={() => { setSelectedId(selected ? undefined : job.id) }}
                  >
                    <StateDot state={jobDotState(job.status)} className={css.jobsDot} />
                    <span className={css.jobsContent}>
                      <span className={css.jobsLabelLine}>
                        <span className={css.jobsKind}>{job.kind}</span>
                        <span className={css.jobsLabel} title={job.label}>{job.label}</span>
                      </span>
                      <span className={css.jobsSecondary}>{secondary}</span>
                    </span>
                  </button>
                  {job.status === 'running' && (
                    <button
                      type="button"
                      className={armed ? `${css.jobsKill} ${css.jobsKillArmed}` : css.jobsKill}
                      aria-label={armed ? t('jobKillConfirm') : t('jobKill')}
                      title={armed ? t('jobKillConfirm') : t('jobKill')}
                      disabled={killing}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (armed) void kill(row)
                        else setArmedId(job.id)
                      }}
                    >
                      {armed ? t('jobKillConfirm') : <IconStopOutline16 size={12} />}
                    </button>
                  )}
                  {killFailed && <span className={css.jobsKillError}>{t('jobKillError')}</span>}
                </div>
                {selected && (
                  <JobTerminal
                    ownerSessionId={row.ownerSessionId}
                    job={job}
                    active={active}
                    onCollapse={() => { setSelectedId(undefined) }}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )
}

// ── Agent terminals (the model's live terminal operations) ─────────────────

/** One agent terminal row from the host's /sidebar/ws/agent-terminals push:
 *  a plugin-owned terminal (created through the terminal_* tools) or a
 *  HARNESS-owned terminal (the main agent's stock PTY surface). */
type AgentTerminalEntry =
  | { kind: 'plugin'; uuid: string; title: string; command: string; exited: boolean }
  | { kind: 'harness'; id: string; title: string; type: string; exited: boolean }

/** How many consecutive list-socket failures stop the reconnect loop. */
const AGENT_LIST_FAILURE_LIMIT = 3

/**
 * The read-only STREAM of one agent terminal: attaches to the terminal
 * WebSocket (?uuid=...) which replays the transcript and then follows the
 * live output. Purely a viewer — no input frames, and the unmount closes
 * the socket BARE (never a {type:'close'} frame), so the agent's pty keeps
 * running untouched. Terminal-tail behavior mirrors the job terminal:
 * pinned to the newest output while live (blinking cursor), a "follow
 * latest" chip once the reader scrolls up.
 */
function AgentTerminalStream(props: {
  /** Plugin terminals attach by uuid; harness terminals by session + id. */
  source: { kind: 'plugin'; uuid: string } | { kind: 'harness'; sessionId: string; id: string }
  title: string
  command: string
  exited: boolean
  onCollapse: () => void
}) {
  const { source, title, command, exited, onCollapse } = props
  const [text, setText] = useState('')
  const [live, setLive] = useState(!exited)
  const [pinned, setPinned] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setText('')
    setLive(!exited)
    setPinned(true)
    const url = source.kind === 'harness'
      ? new URL('/sidebar/ws/harness-terminal', location.origin)
      : new URL('/sidebar/ws/terminal', location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = source.kind === 'harness'
      ? new URLSearchParams({ sessionId: source.sessionId, id: source.id }).toString()
      : new URLSearchParams({ uuid: source.uuid }).toString()
    const socket = new WebSocket(url.toString())
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      setText(current => current + event.data)
      if ((event.data as string).includes('[process exited')) setLive(false)
    }
    socket.onclose = () => { setLive(false) }
    return () => {
      // Bare drop: the pty stays alive (the agent owns its lifetime).
      socket.close()
    }
  }, [source, exited])

  // Terminal-tail behavior: while live and pinned, follow the newest output.
  useEffect(() => {
    if (!live || !pinned || text === '') return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
  }, [text, live, pinned])

  const onScroll = (): void => {
    const pre = preRef.current
    if (pre === null) return
    setPinned(pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8)
  }

  const follow = (): void => {
    setPinned(true)
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
  }

  return (
    <div className={css.jobTerminal} role="region" aria-label={`${title} ${t('agentTerminals')}`}>
      <div className={css.jobTerminalHeader}>
        <StateDot state={live ? 'ongoing' : 'done'} className={css.jobTerminalDot} />
        <span className={css.jobTerminalLabel} title={title}>{title}</span>
        <span className={css.jobTerminalStatus}>
          {live ? t('agentTerminalRunning') : t('agentTerminalExited')}
          {command !== '' ? ` · ${command}` : ''}
        </span>
        <button
          type="button"
          className={css.jobTerminalClose}
          aria-label={t('close')}
          title={t('close')}
          onClick={onCollapse}
        >
          <IconStopOutline16 size={10} />
        </button>
      </div>
      <div className={css.jobTerminalBody}>
        {text === ''
          ? <div className={css.jobTerminalHint}>{t('loading')}</div>
          : (
            <pre ref={preRef} className={css.jobTerminalPre} onScroll={onScroll}>
              {text}
              {live && <span className={css.jobTerminalCursor} aria-hidden="true">▍</span>}
            </pre>
          )}
        {live && !pinned && text !== '' && (
          <button type="button" className={css.jobTerminalFollow} onClick={follow}>
            {t('jobFollowOutput')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The agent-terminals section of the Tasks page: the model's LIVE terminal
 * operations (created through the terminal_* tools), fed by the host's
 * /sidebar/ws/agent-terminals push. Rows are compact thumbnails (state dot,
 * title, command, live/exited); clicking a row expands an inline read-only
 * STREAMING view of that terminal (transcript replay + live output, the
 * same protocol the terminal tabs use — no input, and dropping the view
 * never kills the agent's shell). Hidden entirely while the terminal tab
 * type is disabled or the list is empty.
 */
function AgentTerminalsSection(props: {
  ctx: Context
  sessionId: string
  active: boolean
  /** Auto-expand the streaming view of a NEW agent terminal (the autoOpenJobStream pref). */
  autoExpandStream: boolean
}) {
  const { ctx, sessionId, active, autoExpandStream } = props
  const [entries, setEntries] = useState<AgentTerminalEntry[]>([])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const enabled = ctx.vscodeSidebar?.isTabEnabled('terminal') !== false

  /** Stable row key of one entry (plugin uuid / harness session id). */
  const keyOf = (entry: AgentTerminalEntry): string => (entry.kind === 'harness' ? entry.id : entry.uuid)

  // Auto-expand (autoOpenJobStream): an entry this snapshot lacks (a freshly
  // created agent terminal) expands its streaming view without a click. The
  // first snapshot while the page opens expands the first LIVE terminal, so
  // the page shows the stream immediately.
  const keysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const keys = new Set(entries.map(keyOf))
    const prev = keysRef.current
    keysRef.current = keys
    if (!autoExpandStream) return
    for (const entry of entries) {
      if (!entry.exited && !prev.has(keyOf(entry))) {
        setExpandedKey(keyOf(entry))
        return
      }
    }
  }, [entries, autoExpandStream])

  useEffect(() => {
    if (!active || !enabled) {
      setEntries([])
      setExpandedKey(null)
      return
    }
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-terminals', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const raw = JSON.parse(event.data) as unknown
          if (!Array.isArray(raw)) return
          // Defensive wire parse: harness entries carry kind+id; everything
          // else is a plugin terminal (frames predating the harness feed
          // lack `kind` entirely and still carry a uuid).
          const list = raw.map((item): AgentTerminalEntry | null => {
            if (item === null || typeof item !== 'object') return null
            const record = item as Record<string, unknown>
            if (record.kind === 'harness' && typeof record.id === 'string') {
              return {
                kind: 'harness',
                id: record.id,
                title: typeof record.title === 'string' ? record.title : 'terminal',
                type: typeof record.type === 'string' ? record.type : '',
                exited: record.exited === true,
              }
            }
            if (typeof record.uuid === 'string') {
              return {
                kind: 'plugin',
                uuid: record.uuid,
                title: typeof record.title === 'string' ? record.title : 'terminal',
                command: typeof record.command === 'string' ? record.command : '',
                exited: record.exited === true,
              }
            }
            return null
          }).filter((entry): entry is AgentTerminalEntry => entry !== null)
          setEntries(list)
          setExpandedKey(current => (current !== null && list.some(entry => keyOf(entry) === current) ? current : null))
        } catch {
          // Malformed push: ignore (the next push will reconcile).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= AGENT_LIST_FAILURE_LIMIT) return
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, active, enabled])

  if (entries.length === 0) return null

  const liveCount = entries.reduce((count, entry) => count + (entry.exited ? 0 : 1), 0)
  const countLabel = liveCount > 0
    ? t('agentTerminalsCountRunning', { count: entries.length, running: liveCount })
    : t('agentTerminalsCount', { count: entries.length })
  const expanded = entries.find(entry => keyOf(entry) === expandedKey)

  return (
    <section className={css.jobs} aria-label={t('agentTerminals')}>
      <div className={css.jobsHeader}>
        <span className={css.jobsTitle}>{t('agentTerminals')}</span>
        <span className={css.jobsCount}>{countLabel}</span>
      </div>
      <ul className={css.jobsList}>
        {entries.map(entry => {
          const selected = keyOf(entry) === expandedKey
          const secondary = entry.kind === 'harness' ? entry.type : entry.command
          return (
            <li
              key={keyOf(entry)}
              className={clsx(
                css.jobsRow,
                entry.exited && css.jobsRowSettled,
                selected && css.jobsRowSelected,
              )}
            >
              <div className={css.jobsRowLine}>
                <button
                  type="button"
                  className={css.jobsRowMain}
                  aria-pressed={selected}
                  aria-label={`${entry.title} ${secondary}`}
                  onClick={() => { setExpandedKey(selected ? null : keyOf(entry)) }}
                >
                  <StateDot state={entry.exited ? 'done' : 'ongoing'} className={css.jobsDot} />
                  <span className={css.jobsContent}>
                    <span className={css.jobsLabelLine}>
                      <span className={css.jobsKind}>terminal</span>
                      <span className={css.jobsLabel} title={entry.title}>{entry.title}</span>
                    </span>
                    <span className={css.jobsSecondary}>
                      {[
                        secondary,
                        entry.exited ? t('agentTerminalExited') : t('agentTerminalRunning'),
                      ].filter(part => part !== '').join(' · ')}
                    </span>
                  </span>
                </button>
              </div>
              {selected && (
                <AgentTerminalStream
                  source={entry.kind === 'harness'
                    ? { kind: 'harness', sessionId, id: entry.id }
                    : { kind: 'plugin', uuid: entry.uuid }}
                  title={entry.title}
                  command={entry.kind === 'harness' ? '' : entry.command}
                  exited={entry.exited}
                  onCollapse={() => { setExpandedKey(null) }}
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The sidebar's Subagent topology page.
 * @param props - current session id, whether the page is actually visible
 *   (active tab + open panel), the client context, and an optional
 *   jump-notify hook fired right before `openSubagent` (lets the sidebar
 *   shell re-open the Subagent page after the conversation switch lands on
 *   the child session).
 * @returns the main agent's topology tree, or the empty/error/loading states.
 */
export function SubagentView(props: {
  sessionId: string
  active: boolean
  ctx: Context
  /** The sidebar store (only its prefs face is needed). */
  store: { getPrefs(): SidebarPrefs }
  onOpenChild?: (address: SidebarSubagentAddress) => void
}) {
  const { sessionId, active, ctx, store, onOpenChild } = props
  const sessions = ctx.sessions
  /** The autoOpenJobStream pref, read live (store changes re-render). */
  const autoExpandStream = store.getPrefs().autoOpenJobStream !== false

  // The same list feed the official catalog consumes (byId lineage + the
  // lazy per-parent catalogs). Older DSH snapshots without the subagent seam
  // simply leave these surfaces empty — the page degrades to the empty state.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const byId = list.byId
  const catalogs = list.subagentsByParent ?? {}

  // The topology root: the main agent of the current session's tree.
  const rootId = useMemo(() => rootAncestor(byId, sessionId), [byId, sessionId])
  const rootCatalog = rootId === undefined ? undefined : catalogs[rootId]
  const rootSummary = rootId === undefined ? undefined : byId[rootId]

  /** Catalog owners currently consuming live membership updates. */
  const observedRef = useRef(new Set<string>())

  const observe = useCallback((parentSessionId: string, open: boolean): void => {
    sessions.setSubagentCatalogOpen?.(parentSessionId, open)
    if (open) observedRef.current.add(parentSessionId)
    else observedRef.current.delete(parentSessionId)
  }, [sessions])

  // While the page is visible the topology root consumes live membership; a
  // root change (switching to another main agent's tree) or the page hiding
  // (tab switched away / panel collapsed) releases everything observed.
  useEffect(() => {
    if (rootId === undefined || !active) return
    observe(rootId, true)
    return () => {
      for (const parentSessionId of observedRef.current) {
        sessions.setSubagentCatalogOpen?.(parentSessionId, false)
      }
      observedRef.current.clear()
    }
  }, [rootId, active, observe, sessions])

  // Every branch of the always-expanded topology consumes live membership
  // (add-only: a branch stays observed until the root changes or the page
  // hides, which releases the whole set via the root effect's cleanup).
  const branches = useMemo(() => collectBranchIds(catalogs, rootId), [catalogs, rootId])
  useEffect(() => {
    if (!active) return
    for (const id of branches) {
      if (!observedRef.current.has(id)) observe(id, true)
    }
  }, [branches, active, observe])

  // Unobserve everything on unmount (the host stops refreshing unused catalogs).
  useEffect(() => () => {
    for (const parentSessionId of observedRef.current) {
      sessions.setSubagentCatalogOpen?.(parentSessionId, false)
    }
    observedRef.current.clear()
  }, [sessions])

  const openChild = useCallback((address: SidebarSubagentAddress): void => {
    // Notify the shell first: the jump switches the sidebar to the child
    // session's own layout, and the shell re-opens the Subagent page on top
    // of it (the topology stays rooted at the main agent with the child
    // highlighted) — the README "page stays open" contract.
    onOpenChild?.(address)
    try {
      sessions.openSubagent?.(address)
    } catch (error) {
      console.warn('[dsh-plugin-vscode-sidebar] openSubagent failed:', error)
    }
  }, [sessions, onOpenChild])

  /** Jump back to the main agent (the topology root) from its node. */
  const openMain = useCallback((): void => {
    if (rootId === undefined) return
    try {
      sessions.open?.(rootId)
    } catch (error) {
      console.warn('[dsh-plugin-vscode-sidebar] open session failed:', error)
    }
  }, [sessions, rootId])

  const refresh = useCallback((parentSessionId: string): void => {
    void sessions.refreshSubagents?.(parentSessionId)
  }, [sessions])

  const totals = useMemo(
    () => rootId === undefined
      ? { count: 0, runningCount: 0 }
      : countSubagentDescendants(byId, rootId),
    [byId, rootId],
  )
  // Session summaries can announce membership before the descriptor-backed
  // catalog catches up (or a catalog that just went ready is still empty).
  const summaryBackedLoading = rootId !== undefined
    && (rootCatalog === undefined || (rootCatalog.state === 'ready' && rootCatalog.entries.length === 0))
    && directChildren(byId, rootId).length > 0
  const readyEmpty = rootCatalog?.state === 'ready'
    && rootCatalog.entries.length === 0
    && directChildren(byId, rootId ?? '').length === 0
  const countLabel = totals.count === 0
    ? undefined
    : totals.runningCount > 0
      ? t('subagentCountRunning', { count: totals.count, running: totals.runningCount })
      : t('subagentCount', { count: totals.count })

  /** Arrow-key tree navigation over the visible rows (official catalog recipe). */
  const bodyRef = useRef<HTMLDivElement>(null)
  const focusAt = useCallback((index: number): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>(
      '[role="treeitem"]:not([aria-disabled="true"])',
    ) ?? []
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }, [])
  const onTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>(
      '[role="treeitem"]:not([aria-disabled="true"])',
    ) ?? []
    const index = Array.prototype.indexOf.call(items, document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    }
  }, [focusAt])

  return (
    <div className={css.subagent}>
      <div className={css.subagentHeader}>
        <span className={css.subagentTitle}>
          {t('subagent')}
          {rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== ''
            ? ` · ${rootSummary.displayTitle}`
            : ''}
        </span>
        {countLabel !== undefined && <span className={css.subagentCount}>{countLabel}</span>}
        <button
          type="button"
          className={css.subagentRefresh}
          aria-label={t('refresh')}
          title={t('refresh')}
          disabled={rootId === undefined}
          onClick={() => { if (rootId !== undefined) refresh(rootId) }}
        >
          <IconRefreshOutline14 />
        </button>
      </div>
      <div
        ref={bodyRef}
        className={css.subagentBody}
        onKeyDown={onTreeKeyDown}
      >
        <div
          role="tree"
          aria-label={t('subagent')}
          aria-busy={summaryBackedLoading || undefined}
        >
          {rootId !== undefined && rootSummary !== undefined && (
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={0}
              aria-label={`${rootSummary.displayTitle !== '' ? rootSummary.displayTitle : t('subagentMainAgent')} ${t('subagentMainAgent')}`}
              aria-current={rootId === sessionId ? 'true' : undefined}
              className={clsx(css.subagentRow, rootId === sessionId && css.subagentRowActive)}
              onClick={openMain}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  openMain()
                }
              }}
            >
              <StateDot
                state={rootSummary.running === true ? 'ongoing' : 'done'}
                className={css.subagentDot}
              />
              <span className={css.subagentContent}>
                <span className={css.subagentLabel}>
                  {rootSummary.displayTitle !== '' ? rootSummary.displayTitle : t('subagentMainAgent')}
                </span>
                <span className={css.subagentSecondary}>
                  {`${t('subagentMainAgent')} · ${rootSummary.running === true ? t('subagentRunning') : t('subagentInactive')}`}
                </span>
              </span>
            </div>
          )}
          {rootId !== undefined && (
            <div className={css.subagentChildren} role="group" aria-busy={summaryBackedLoading || undefined}>
              {summaryBackedLoading && (
                <CatalogLoadingRows parentSessionId={rootId} byId={byId} level={1} />
              )}
              {!summaryBackedLoading && (
                <CatalogRows
                  parentSessionId={rootId}
                  catalog={rootCatalog}
                  catalogs={catalogs}
                  byId={byId}
                  level={1}
                  currentSessionId={sessionId}
                  active={active}
                  ctx={ctx}
                  openChild={openChild}
                  refresh={refresh}
                />
              )}
            </div>
          )}
          {readyEmpty && (
            <div className={css.subagentEmpty}>
              <div>{t('subagentEmpty')}</div>
              <div className={css.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
            </div>
          )}
        </div>
        <JobsSection
          byId={byId}
          jobsBySession={list.jobsBySession}
          rootId={rootId}
          active={active}
          autoExpandStream={autoExpandStream}
        />
        <AgentTerminalsSection
          ctx={ctx}
          sessionId={sessionId}
          active={active}
          autoExpandStream={autoExpandStream}
        />
      </div>
    </div>
  )
}
