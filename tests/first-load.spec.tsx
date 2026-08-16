/**
 * First-load transition tests: reproduce the real page-load sequence that
 * the steady-state tests never exercise — the sidebar mounts while the
 * harness is still hydrating (session summary WITHOUT a cwd, no jobs, no
 * agent terminals), then the async data arrives in the same order the real
 * host delivers it. Any hook-order violation across those transitions
 * surfaces as React's "Rendered more/fewer hooks than during the previous
 * render" (the minified #310/#309 the sidebar boundary strips show).
 *
 * The transitions driven here:
 *  1. mount with cwd-absent session summary,
 *  2. session hydration (cwd arrives on the list feed),
 *  3. a prefs document commit (settingsScope push),
 *  4. opening git / subagent / terminal / browser tabs,
 *  5. a jobs list arriving (empty → non-empty JobsSection),
 *  6. an agent-terminal list push (empty → non-empty AgentTerminalsSection
 *     + the sidebar's tab mirror).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createVscodeSidebarService, type VscodeSidebarService } from '../src/client/service.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'
import { parsePrefs } from '../src/client/prefs.ts'
import { t } from '../src/client/locales.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

/** jsdom has no WebSocket; capture instances so the test can drive pushes. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }
}

interface MountedSidebar {
  container: HTMLDivElement
  store: SidebarStore
  service: VscodeSidebarService
  setSessionList: (next: unknown) => void
  unmount: () => void
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** Mount the real shell against a first-load-shaped (still hydrating) feed. */
function mountFirstLoad(current: string | undefined = 's1'): MountedSidebar {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances.length = 0
  // The host routes the first-load paths hit: sessionCwd, fs.tree, git.repos,
  // jobs.output. Anything else (the lazy terminal/editor chunks) fails like
  // an unreachable bundle would — the lazy-chunk error state must not crash.
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    const method = String(url).split('/').pop()
    if (method === 'sessionCwd') return jsonResponse({ ok: true, value: { cwd: 'C:/demo' } })
    if (method === 'fs.tree') return jsonResponse({ ok: true, value: { entries: [] } })
    if (method === 'git.repos') return jsonResponse({ ok: true, value: { repos: [] } })
    if (method === 'jobs.output') return jsonResponse({ ok: true, value: { text: 'output', truncated: false, read: true } })
    throw new Error(`unexpected fetch ${String(url)}`)
  })

  // cwd ABSENT initially — the real harness hydrates the summary later.
  let sessionsSnapshot = current === undefined
    ? { current: undefined, byId: {}, subagentsByParent: {}, jobsBySession: {} }
    : {
      current,
      byId: { s1: { id: 's1', displayTitle: 'demo', running: true } },
      subagentsByParent: {},
      jobsBySession: {},
    }
  const listeners = new Set<() => void>()
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createVscodeSidebarService(store)
  const localeSnapshot = { active: 'en' }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: {
      list: {
        getSnapshot: () => sessionsSnapshot,
        subscribe: (fn: () => void) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      },
    },
    vscodeSidebar: service,
    connection: { api: {} },
  }
  // The real shell registers its builtins before mounting.
  registerBuiltins(ctx as never, service)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  return {
    container,
    store,
    service,
    setSessionList: (next: unknown) => {
      sessionsSnapshot = next as typeof sessionsSnapshot
      for (const fn of [...listeners]) fn()
    },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('first-load hydration transitions', () => {
  it('survives the mount → hydration → data sequence without a hook-order crash', async () => {
    const { container, store, service, setSessionList, unmount } = mountFirstLoad()

    // The no-session cluster renders before the store hydrates `state`.
    expect(container.textContent).toContain(t('noSession'))

    // 2. Session hydration: the summary gains its cwd (explorer/git re-root).
    await act(async () => {
      setSessionList({
        current: 's1',
        byId: { s1: { id: 's1', displayTitle: 'demo', running: true, cwd: 'C:/demo' } },
        subagentsByParent: {},
        jobsBySession: {},
      })
    })
    // The cwd fetch may resolve inside the act window; flush microtasks.
    await act(async () => { await Promise.resolve() })

    // The hydrated shell replaces the no-session cluster with the real panel.
    expect(container.textContent).not.toContain(t('noSession'))

    // 3. A settings document commit arrives (the live settingsScope push).
    act(() => {
      store.setPrefs(parsePrefs({ ...SIDEBAR_PREFS_DEFAULTS, htmlViewerDefaultUnsafe: true }))
    })

    // 4. The tab roster opens: git, subagent, browser, and a terminal (the
    //    lazy terminal chunk fails in jsdom — its error card must not crash).
    act(() => { service.openTab({ type: 'git', title: 'git' }) })
    act(() => { service.openTab({ type: 'subagent', title: 'subagent' }) })
    act(() => { service.openTab({ type: 'browser', title: 'browser' }) })
    act(() => { service.openTab({ type: 'terminal', title: 'terminal' }) })

    // 5. Jobs arrive: JobsSection mounts empty and gains a running row
    //    (autoOpenJobStream is on by default: its stream view expands too).
    await act(async () => {
      setSessionList({
        current: 's1',
        byId: { s1: { id: 's1', displayTitle: 'demo', running: true, cwd: 'C:/demo' } },
        subagentsByParent: {},
        jobsBySession: {
          s1: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }],
        },
      })
      await Promise.resolve()
    })

    // 6. The agent-terminal feed pushes a live terminal: the sidebar's tab
    //    mirror adds a tab while the Tasks section gains its entry row.
    await act(async () => {
      const socket = FakeWebSocket.instances.at(-1)
      socket?.onmessage?.({ data: JSON.stringify([{ uuid: 'u1', title: 'agent shell', command: 'bash', exited: false }]) })
      await Promise.resolve()
    })

    // The shell must still be healthy: no boundary strip, no hook-order text.
    const text = container.textContent ?? ''
    expect(text).not.toContain('Minified React error')
    expect(text).not.toContain('Rendered more hooks')
    expect(text).not.toContain('Rendered fewer hooks')
    // The explorer tab still renders (the shell never swapped out).
    expect(container.querySelector('[class*="explorer"]')).not.toBeNull()
    unmount()
  })

  it('survives a mount with NO current session at all, then the session arriving', async () => {
    // The no-session branch of the early return (sessionId === undefined):
    // the very first render has neither a state nor a session, the hydration
    // render gains both — the same hook-order cliff in the other direction.
    const { container, setSessionList, unmount } = mountFirstLoad(undefined)
    expect(container.textContent).toContain(t('noSession'))

    await act(async () => {
      setSessionList({
        current: 's1',
        byId: { s1: { id: 's1', displayTitle: 'demo', running: true, cwd: 'C:/demo' } },
        subagentsByParent: {},
        jobsBySession: {},
      })
      await Promise.resolve()
    })

    const text = container.textContent ?? ''
    expect(text).not.toContain(t('noSession'))
    expect(text).not.toContain('Minified React error')
    expect(text).not.toContain('Rendered more hooks')
    expect(text).not.toContain('Rendered fewer hooks')
    unmount()
  })
})
