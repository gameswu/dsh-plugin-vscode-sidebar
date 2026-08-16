/**
 * Typed fetch wrapper over the /sidebar JSON API. Every call posts to
 * `/sidebar/api/<method>` with the sessionId and — when known — the session's
 * cwd from the client's own list summary. The host prefers its attached
 * session header and uses the summary cwd only while the session is still
 * hydrating at page load (a detached session would otherwise fail the
 * request). Failures surface as {@link SidebarApiError} with the wire code.
 */
import { encodeHtmlUrl } from '../html-route.ts'
import type { BrowserProbeResult } from './browser.ts'

/** One wire failure. */
export class SidebarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Explorer row (host fs-tree shape). */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  /** Gitignored inside the enclosing work tree: render dimmed, keep listed. */
  hidden: boolean
  /** Porcelain XY code (SCM-linked decoration; absent outside repos / off). */
  git?: string
}

/** Git status entry (host git shape). */
export interface GitStatusEntry {
  path: string
  xy: string
  /** Absolute twin of the repo-root-relative `path` (editor/copy targets). */
  absPath?: string
  /** Numstat counts for the carried side (undefined = untracked, null = binary). */
  added?: number | null
  deleted?: number | null
}

/** One discovered repository (host git discovery shape). */
export interface GitRepoInfo {
  root: string
  branch?: string
}

/** Git status snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  /** The root of the repository this snapshot was taken from. */
  root?: string
  branch?: string
  entries: GitStatusEntry[]
  /** Discovered repositories (enclosing first) for the repo picker. */
  repos?: GitRepoInfo[]
  /** Ahead/behind counts against the upstream branch. */
  aheadBehind?: { upstream: string; ahead: number; behind: number } | null
}

/** One git log row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`). */
  date: string
  /** Ref decorations (--decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
  /** Full parent hashes (the history lane graph's topology). */
  parents: string[]
}

/** Text read result. */
export interface FsTextResult { kind: 'text'; content: string; truncated: boolean }
/** Binary read result (no content; images load through the media route).
 *  `head` carries the first bytes (base64) for viewer detect sniffing. */
export interface FsBinaryResult { kind: 'binary'; size: number; truncated: boolean; head: string }

/**
 * One jobs.output response: the output the MODEL has read so far for the
 * job (replayed from the owner session's event log — the model's
 * job_output cursor is never touched, so the pane can never steal the
 * agent's bytes). `read` is false until the model actually called
 * job_output for the job.
 */
export interface JobOutputResult {
  text: string
  /** True when the host capped the text at its output limit. */
  truncated: boolean
  /** Whether the model has read the job at least once. */
  read: boolean
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/sidebar/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new SidebarApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new SidebarApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** One request's session scope: the conversation id plus its cwd when known. */
export interface SessionScope {
  sessionId: string
  /** The session's working directory from the client list summary (optional). */
  cwd?: string
}

/** Fold a scope into a JSON payload ({cwd} only when present). */
function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: scope.sessionId, ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}), ...extra }
}

/** Append the optional repo root to a git payload (multi-repo picker). */
function repoPayload(scope: SessionScope, repo: string | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  return scopePayload(scope, { ...(repo !== undefined && repo !== '' ? { repo } : {}), ...extra })
}

/** The sidebar API surface (session scope threaded through every call). */
export const api = {
  sessionCwd: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ sessionId: string; cwd: string; root: string; parent: string | null }>('session.cwd', scopePayload(scope, {}), signal),
  fsTree: (scope: SessionScope, path: string, signal?: AbortSignal) =>
    call<{ path: string; entries: FsEntry[]; truncated: boolean }>('fs.tree', scopePayload(scope, { path }), signal),
  fsRead: (scope: SessionScope, path: string, repo?: string, signal?: AbortSignal) =>
    call<FsTextResult | FsBinaryResult>('fs.read', repoPayload(scope, repo, { path }), signal),
  fsWrite: (scope: SessionScope, path: string, content: string) =>
    call<{ ok: true }>('fs.write', scopePayload(scope, { path, content })),
  /** Create one entry inside `path` (the parent directory). */
  fsCreate: (scope: SessionScope, path: string, name: string, isDir: boolean) =>
    call<{ ok: true; path: string }>('fs.create', scopePayload(scope, { path, name, isDir })),
  /** Rename one entry to a new name inside the same directory. */
  fsRename: (scope: SessionScope, path: string, name: string) =>
    call<{ ok: true; path: string }>('fs.rename', scopePayload(scope, { path, name })),
  /** Move one entry into another directory (keeps its name). */
  fsMove: (scope: SessionScope, path: string, to: string) =>
    call<{ ok: true; path: string }>('fs.move', scopePayload(scope, { path, to })),
  /** Delete one entry (recursive for directories). */
  fsDelete: (scope: SessionScope, path: string) =>
    call<{ ok: true }>('fs.delete', scopePayload(scope, { path })),
  gitStatus: (scope: SessionScope, repo?: string, signal?: AbortSignal) =>
    call<GitStatusResult>('git.status', repoPayload(scope, repo, {}), signal),
  /** Discovered repositories only (no status computation — the multi-repo
   *  panel's list). `force` bypasses the host's 30s discovery TTL. */
  gitRepos: (scope: SessionScope, force?: boolean, signal?: AbortSignal) =>
    call<{ repos: GitRepoInfo[] }>('git.repos', scopePayload(scope, { ...(force === true ? { force: true } : {}) }), signal),
  gitDiff: (scope: SessionScope, path: string | undefined, staged: boolean, repo?: string, signal?: AbortSignal) =>
    call<{ diff: string }>('git.diff', repoPayload(scope, repo, { ...(path !== undefined ? { path } : {}), staged }), signal),
  gitStage: (scope: SessionScope, path?: string, repo?: string) =>
    call<{ ok: true }>('git.stage', repoPayload(scope, repo, { ...(path !== undefined ? { path } : {}) })),
  gitUnstage: (scope: SessionScope, path?: string, repo?: string) =>
    call<{ ok: true }>('git.unstage', repoPayload(scope, repo, { ...(path !== undefined ? { path } : {}) })),
  gitCommit: (scope: SessionScope, message: string, repo?: string) =>
    call<{ ok: true }>('git.commit', repoPayload(scope, repo, { message })),
  gitBranch: (scope: SessionScope, repo?: string, signal?: AbortSignal) =>
    call<{ current: string; names: string[] }>('git.branch', repoPayload(scope, repo, {}), signal),
  gitCheckout: (scope: SessionScope, branch: string, repo?: string) =>
    call<{ ok: true }>('git.checkout', repoPayload(scope, repo, { branch })),
  /** Recent commit history, lazily pageable (skip/count; defaults 0/30). */
  gitLog: (scope: SessionScope, count?: number, skip?: number, repo?: string, signal?: AbortSignal) =>
    call<GitLogEntry[]>('git.log', repoPayload(scope, repo, {
      ...(count !== undefined ? { count } : {}),
      ...(skip !== undefined ? { skip } : {}),
    }), signal),
  /** Full patch text of one commit (diff display for the history rows). */
  gitCommitDiff: (scope: SessionScope, hash: string, repo?: string, signal?: AbortSignal) =>
    call<{ diff: string }>('git.commit-diff', repoPayload(scope, repo, { hash }), signal),
  /** Discard the worktree changes of one file (the index is untouched). */
  gitDiscard: (scope: SessionScope, path: string, repo?: string) =>
    call<{ ok: true }>('git.discard', repoPayload(scope, repo, { path })),
  /** Revert one commit onto the current branch. */
  gitRevert: (scope: SessionScope, hash: string, repo?: string) =>
    call<{ ok: true }>('git.revert', repoPayload(scope, repo, { hash })),
  /** Cherry-pick one commit onto the current branch. */
  gitCherryPick: (scope: SessionScope, hash: string, repo?: string) =>
    call<{ ok: true }>('git.cherry-pick', repoPayload(scope, repo, { hash })),
  /** Release a terminal's process immediately (tab closed; the WS close frame
   *  may be unreachable while the socket is down, so the host also accepts
   *  this explicit route). */
  ptyClose: (scope: SessionScope, tab: string) =>
    call<{ ok: true }>('pty.close', scopePayload(scope, { tab })),
  /** Release an agent terminal by uuid (tab closed while WS was down). */
  agentPtyClose: (uuid: string) =>
    call<{ ok: true }>('agent-pty.close', { uuid }),
  /**
   * The output the model has read so far for one background job (replayed
   * from the owner session's event log — never the model's job_output
   * cursor). The scope MUST be the job's OWNER session.
   */
  jobOutput: (scope: SessionScope, id: string, signal?: AbortSignal) =>
    call<JobOutputResult>('jobs.output', scopePayload(scope, { id }), signal),
  /** Request cancellation of one background job (live jobs flip to stopping). */
  jobKill: (scope: SessionScope, id: string, reason?: string) =>
    call<{ ok: true; outcome: 'requested' | 'already-finished' }>('jobs.kill', scopePayload(scope, {
      id,
      ...(reason !== undefined ? { reason } : {}),
    })),
  /** Read the side card preferences (plugin-global, no session scope). */
  settingsGet: () =>
    call<{ value?: unknown; revision?: number }>('settings.get', {}),
  /** Merge a patch into the side card preferences (revision-guarded). */
  settingsUpdate: (patch: Record<string, unknown>, expectedRevision?: number) =>
    call<{ value?: unknown; revision?: number }>('settings.update', {
      patch,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    }),
  /** Probe a URL's response headers (the sidebar browser's embeddability
   *  check; see the host's browser.probe route). */
  browserProbe: (url: string, signal?: AbortSignal) =>
    call<BrowserProbeResult>('browser.probe', { url }, signal),
}

/** Absolute URL of the media route for one path (images only). */
export function mediaUrl(scope: SessionScope, path: string): string {
  return fileUrl(scope, path, false)
}

/** Absolute URL of the download route: serves raw bytes (binary-safe) with
 *  `Content-Disposition: attachment`, so the browser saves the file. */
export function downloadUrl(scope: SessionScope, path: string): string {
  return fileUrl(scope, path, true)
}

/** Shared URL builder for the /sidebar/file route (media vs download). */
function fileUrl(scope: SessionScope, path: string, download: boolean): string {
  const params = new URLSearchParams({ sessionId: scope.sessionId, path })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  if (download) params.set('download', '1')
  return `/sidebar/file?${params.toString()}`
}

/** Absolute URL of the HTML preview route (see html-route.ts): the path is
 *  fully encoded so the previewed page's relative assets resolve back into
 *  the same route with the session scope intact. */
export function htmlUrl(scope: SessionScope, path: string): string {
  return encodeHtmlUrl(scope.sessionId, path)
}
