/**
 * Harness terminal-run tracking: the MAIN agent's "terminal" in stock DSH
 * compositions is the shell TOOL (dsh-tool-pwsh on Windows, dsh-tool-bash
 * elsewhere) — a FOREGROUND subprocess executor, not the optional PTY
 * registry. Its only durable surface is the session event log: `tool/call`
 * rows carry the command, the paired `tool/result` rows carry the finalized
 * output. This module extracts those traces (same approach as the job_output
 * replay) plus a live mirror over the session append feed, so the Tasks page
 * can list and replay the agent's shell runs even in deployments where
 * `ctx.terminals` is not mounted at all.
 */
import type { Context, SidebarSessionEvent } from './context-types.ts'

/** Model-facing tool names that count as the agent's shell terminal. */
const TERMINAL_TOOL_NAMES = new Set(['pwsh', 'bash', 'sh', 'zsh', 'cmd', 'terminal'])

/** One compact shell-run trace (a tool/call or its paired tool/result). */
export interface TerminalRunTrace {
  seq: number
  kind: 'call' | 'result'
  /** The tool call identity pairing the two rows. */
  callId: string
  /** tool/call: the model-facing tool name ('pwsh' | 'bash' | …). */
  name?: string
  /** tool/call: the command the model asked to run. */
  command?: string
  /** tool/result: the finalized text the model received. */
  text?: string
  /** tool/result: whether the result was an error (text skipped). */
  isError?: boolean
}

/** The tool/result message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (the inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/** Extract the plain text of a finalized tool result (text blocks joined). */
function resultText(message: ToolResultMessageLike): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as ToolResultBlockLike
    if (candidate.type !== 'tool-result') continue
    const inner = candidate.content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      if (item === null || typeof item !== 'object') continue
      const textItem = item as { type?: unknown; text?: unknown }
      if (textItem.type === 'text' && typeof textItem.text === 'string') {
        parts.push(textItem.text)
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Whether a tool/result is an error result (the inner block's isError flag). */
function resultIsError(message: ToolResultMessageLike): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (block === null || typeof block !== 'object') return false
    return (block as ToolResultBlockLike).type === 'tool-result'
      && (block as ToolResultBlockLike).isError === true
  })
}

/** Extract the shell-run trace of one raw session event (undefined = unrelated). */
export function terminalRunTraceOf(event: SidebarSessionEvent): TerminalRunTrace | undefined {
  if (event.type === 'tool/call') {
    const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
    if (typeof data.name !== 'string' || !TERMINAL_TOOL_NAMES.has(data.name)) return undefined
    if (typeof data.callId !== 'string') return undefined
    let command: string | undefined
    try {
      const args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '') as {
        command?: unknown
        cmd?: unknown
      }
      if (typeof args.command === 'string' && args.command !== '') command = args.command
      else if (typeof args.cmd === 'string' && args.cmd !== '') command = args.cmd
    } catch {
      // Malformed model arguments: the call still lists, without a command.
    }
    return { seq: event.seq, kind: 'call', callId: data.callId, name: data.name, command }
  }
  if (event.type === 'tool/result') {
    const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
    if (message === undefined) return undefined
    const callId = message.source?.callId
    if (typeof callId !== 'string') return undefined
    return { seq: event.seq, kind: 'result', callId, text: resultText(message), isError: resultIsError(message) }
  }
  return undefined
}

/** Per-session cap of mirrored live traces (a bounded, lossy ring). */
const MIRROR_MAX_ENTRIES = 200

/**
 * The live shell-run mirror: subscribes to the session append feed and
 * caches the traces the session store's own log can lag behind (after a
 * host restart the store session stays frozen at its rehydration boundary).
 */
function createTerminalRunMirror(ctx: Context): { entries(sessionId: string): readonly TerminalRunTrace[] } {
  const perSession = new Map<string, TerminalRunTrace[]>()
  const callIds = new Map<string, Set<string>>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API degrade to seed-only replay.
    return { entries: () => [] }
  }
  const push = (sessionId: string, trace: TerminalRunTrace): void => {
    let list = perSession.get(sessionId)
    if (list === undefined) perSession.set(sessionId, list = [])
    list.push(trace)
    if (list.length > MIRROR_MAX_ENTRIES) {
      const removed = list.splice(0, list.length - MIRROR_MAX_ENTRIES)
      const ids = callIds.get(sessionId)
      if (ids !== undefined) {
        for (const entry of removed) {
          if (entry.kind === 'call') ids.delete(entry.callId)
        }
        if (ids.size === 0) callIds.delete(sessionId)
      }
    }
  }
  const dispose = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    if (event.type === 'tool/call') {
      const trace = terminalRunTraceOf(event)
      if (trace?.kind !== 'call') return
      let ids = callIds.get(sessionId)
      if (ids === undefined) callIds.set(sessionId, ids = new Set())
      ids.add(trace.callId)
      push(sessionId, trace)
    } else if (event.type === 'tool/result') {
      const trace = terminalRunTraceOf(event)
      if (trace?.kind !== 'result') return
      if (!callIds.get(sessionId)?.has(trace.callId)) return
      push(sessionId, trace)
    }
  })
  ctx.effect(() => dispose, 'dsh-plugin-vscode-sidebar: terminal-run event mirror')
  return { entries: (sessionId) => perSession.get(sessionId) ?? [] }
}

/** One resolved shell run (a call paired with its result, newest first by seq). */
export interface TerminalRun {
  id: string
  name: string
  /** The command ('' when the call carried none). */
  command: string
  /** Whether the paired result has arrived (settled). */
  settled: boolean
  /** The joined result text ('' until settled / for error results). */
  text: string
}

/**
 * Resolve the session's shell runs from the store's event log merged with
 * the live mirror (deduped by seq), newest first. Unrelated tool rows are
 * ignored; a call without a result yet is still listed as running.
 */
export function listTerminalRuns(ctx: Context, sessionId: string): readonly TerminalRun[] {
  const bySeq = new Map<number, TerminalRunTrace>()
  for (const event of ctx.sessions.get(sessionId)?.events ?? []) {
    const trace = terminalRunTraceOf(event)
    if (trace !== undefined) bySeq.set(trace.seq, trace)
  }
  const mirror = mirrorOf(ctx)
  for (const trace of mirror.entries(sessionId)) bySeq.set(trace.seq, trace)
  const traces = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
  const runs = new Map<string, TerminalRun>()
  for (const trace of traces) {
    if (trace.kind === 'call') {
      runs.set(trace.callId, {
        id: trace.callId,
        name: trace.name ?? 'shell',
        command: trace.command ?? '',
        settled: false,
        text: '',
      })
    } else {
      const run = runs.get(trace.callId)
      if (run !== undefined) {
        run.settled = true
        if (trace.isError !== true && trace.text !== undefined) run.text = trace.text
      }
    }
  }
  return [...runs.values()].reverse()
}

/** One resolved run by callId (undefined when the id names no shell run). */
export function terminalRunOf(ctx: Context, sessionId: string, id: string): TerminalRun | undefined {
  return listTerminalRuns(ctx, sessionId).find(run => run.id === id)
}

// The mirror is per-plugin-fiber state; share one instance across callers
// through a module-level holder keyed by the host context.
let mirrorHolder: { ctx: Context; mirror: ReturnType<typeof createTerminalRunMirror> } | undefined
function mirrorOf(ctx: Context): { entries(sessionId: string): readonly TerminalRunTrace[] } {
  if (mirrorHolder?.ctx !== ctx) mirrorHolder = { ctx, mirror: createTerminalRunMirror(ctx) }
  return mirrorHolder.mirror
}
