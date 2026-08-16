/**
 * Client half of dsh-plugin-vscode-sidebar: resolves the user's "Side card"
 * preferences through the plugin's own fenced settings route, mounts the
 * right sidebar portal (inside an error boundary so a rendering failure
 * shows an error strip instead of a blank panel), registers the turn-tail
 * interception, and contributes the Side card settings section to the DSH
 * Settings shell. Requires the runtime's slots and sessions services; the
 * bundle itself is a module-table consumer only (react + ui-primitives +
 * xterm, all provided or inlined).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context, SidebarSettingsScopeBinder } from '../context-types.ts'
import { createSidebarStore, defaultWidthFor, setWidth } from './state.ts'
import { createVscodeSidebarService } from './service.ts'
import { resetChunks, prefetchBundleAsset } from './chunk-loader.ts'
import { registerBuiltins } from './builtins/index.ts'
import { Sidebar } from './Sidebar.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { registerOpenPathInterception, registerTurnTailInterception } from './intercept.tsx'
import { registerLinkInterception } from './link-intercept.ts'
import { registerImeGuard } from './ime-guard.ts'
import { loadPrefs, parsePrefs, type SidebarPrefs } from './prefs.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { api } from './api.ts'
import { SIDEBAR_PREFS_NS } from '../prefs-shared.ts'
import { LOCALE_NS, attachLocale, t, zh, en } from './locales.ts'
import css from './sidebar.module.css'
import './layout.css'

/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). `remote` is
 *  the client Remote contribution mount: the settings-scope binder resolves
 *  it through the CALLER's context for forwarded settings invalidations. */
export const inject = ['slots', 'sessions', 'connection', 'workspaces', 'locale', 'remote']

/**
 * Error boundary over the sidebar tree (root scope): a render error in the
 * sidebar SHELL itself must never blank the page silently — the shared
 * RenderBoundary shows a dismissible error strip and logs the stack. The
 * per-tab scope (Sidebar.tsx) catches viewer/editor crashes first; this root
 * boundary stays as the last resort for Workbench/shell errors.
 */
/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions).
 */
export function apply(ctx: Context): void {
  // The sidebar follows the DSH i18n system: attach the locale service so
  // the module-level t()/isZh() resolve the Host-backed language preference
  // (and switch live — the Sidebar root subscribes to it), and register the
  // plugin's dictionaries into the shared locale registry. The disposers
  // run on fiber disposal, so re-activation (HMR) re-registers cleanly.
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'dsh-plugin-vscode-sidebar: dictionaries')
  // One store instance per activation: production code creates it only here,
  // then hands it to the mounted panel and closes over it in the slot
  // registrations (the official createXXXStore() factory rule — no
  // module-level singleton).
  const sidebarStore = createSidebarStore()
  // The sidebar registry service: external plugins register tab types and
  // file previewers through `ctx.vscodeSidebar.registerTab/registerFileViewer`.
  // Published before the panel mounts so consumers injecting 'vscodeSidebar'
  // are ready by the time the sidebar renders.
  const service = createVscodeSidebarService(sidebarStore)
  ctx.provide('vscodeSidebar', service)
  // Register the plugin's own built-in tabs and viewers through the same
  // service (eating our own dogfood). The disposer unregisters them on
  // fiber disposal (HMR-safe).
  ctx.effect(
    () => registerBuiltins(ctx, service),
    'dsh-plugin-vscode-sidebar: register built-in tabs and viewers',
  )
  // A failure anywhere in the client lifecycle must never take the app down
  // silently: log with the plugin prefix and pin a visible diagnostic strip
  // to the page so a blank panel is never the only symptom.
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-plugin-vscode-sidebar] ${phase} error:`, error)
    try {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;'
        + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;'
        + 'border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap'
      bar.textContent = `[dsh-plugin-vscode-sidebar] ${phase} error: ${error instanceof Error ? error.message : String(error)}`
      document.body.appendChild(bar)
    } catch {
      // Nothing left to report with.
    }
  }
  try {
    // Fresh chunk state for this activation: invalidate any chunk factories
    // registered by a previous fiber (HMR) and drop the in-memory load cache
    // so the next lazy open re-fetches the current chunk scripts.
    resetChunks()
    // Predictive warm-up: the terminal chunk is the other heavy lazy bundle
    // — prefetch it on idle so the first terminal tab opens instantly.
    prefetchBundleAsset('terminal')
    ctx.effect(() => {
      let disposed = false
      let root: Root | undefined
      let host: HTMLDivElement | undefined
      let offScope: (() => void) | undefined
      // LIVE settings sync: bind the side card namespace through the
      // settings-surface scope binder when the deployment provides one.
      // Every Host settings commit (the official plugin-config page, the
      // side card's own settings section, external document edits) pushes a
      // fresh snapshot into the store, so preference changes apply to the
      // running page immediately instead of waiting for a reload. Without a
      // binder the one-shot fenced read below remains the only source.
      const binder = ctx.get('settingsScope') as SidebarSettingsScopeBinder | undefined
      let liveSeen = false
      if (binder !== undefined) {
        try {
          const scope = binder.bind<SidebarPrefs>({
            namespace: SIDEBAR_PREFS_NS,
            decode: section => parsePrefs(section),
          })
          offScope = scope.subscribe(() => {
            const next = scope.getSnapshot().value
            if (next === undefined) return
            liveSeen = true
            const prev = sidebarStore.getPrefs()
            sidebarStore.setPrefs(next)
            // defaultWidthPercent seeds new sessions; when the live panel is
            // still riding the PREVIOUS default's PIXEL width (never dragged),
            // follow the new default immediately too. Compare in pixels on
            // both sides (state.width is px; the percent itself is never a
            // valid width) and route through setWidth's clamps.
            const current = sidebarStore.getSnapshot().state
            if (current !== undefined) {
              const prevPx = defaultWidthFor(window.innerWidth, prev.defaultWidthPercent)
              const nextPx = defaultWidthFor(window.innerWidth, next.defaultWidthPercent)
              if (current.width === prevPx && current.width !== nextPx) {
                sidebarStore.reduce(state => setWidth(state, nextPx))
              }
            }
          })
        } catch (error) {
          // A binder whose transport cannot be resolved (unusual surface
          // composition) must not cost the sidebar its mount: the one-shot
          // fenced read below remains the fallback source.
          console.error('[dsh-plugin-vscode-sidebar] settings scope bind failed:', error)
        }
      }
      void (async () => {
        // Resolve the user's side card prefs BEFORE the first session seeds,
        // so a brand-new conversation opens (or stays closed) at the chosen
        // width from first paint. A settings route failure falls back to the
        // schema defaults; the sidebar still mounts (a stalled wire gives up
        // after the timeout and mounts on the defaults). A live scope value
        // wins the race (both read the same document; applying the later
        // snapshot is never a regression).
        const prefs = await Promise.race([
          loadPrefs(api),
          new Promise<null>(resolve => { const timer = window.setTimeout(() => resolve(null), 2000) }),
        ])
        if (prefs !== null && !liveSeen) sidebarStore.setPrefs(prefs)
        if (disposed) return
        try {
          host = document.createElement('div')
          host.setAttribute('data-dsh-plugin-vscode-sidebar', '')
          document.body.appendChild(host)
          root = createRoot(host)
          root.render(createElement(RenderBoundary, { className: css.boundaryError }, createElement(Sidebar, { ctx, store: sidebarStore })))
        } catch (error) {
          fail('mount', error)
        }
      })()
      return () => {
        disposed = true
        offScope?.()
        root?.unmount()
        host?.remove()
      }
    }, 'dsh-plugin-vscode-sidebar: sidebar mount')

    // Settings-nav icon swap: the DSH settings shell hardcodes one glyph per
    // WELL-KNOWN section id and renders a generic gear for everything else —
    // the settings.section slot contract carries no icon option, so our
    // 'vscode-sidebar' row would otherwise keep the gear. Watch the shell's
    // nav for OUR row (matched by label) and swap the gear SVG for an inline
    // sidebar glyph reusing the shell's own class (hash-proof) and geometry.
    // The panel unmounts on close and remounts on reopen, so the observer
    // re-applies every time; swapped nodes carry a marker to stay idempotent.
    ctx.effect(
      () => {
        try {
          const NAV_LIST_SELECTOR = '[class*="navList"]'
          const NAV_ICON_SELECTOR = '[class*="navIcon"]'
          const NAV_LABEL_SELECTOR = '[class*="navLabel"]'
          const swap = (): void => {
            const list = document.querySelector(NAV_LIST_SELECTOR)
            if (list === null) return
            const labelText = t('settingsNav')
            for (const cell of list.querySelectorAll('button')) {
              const label = cell.querySelector(NAV_LABEL_SELECTOR)
              if (label === null || label.textContent !== labelText) continue
              const icon = cell.querySelector(NAV_ICON_SELECTOR)
              if (icon === null || icon.getAttribute('data-dsh-sidebar-icon') === '1') continue
              const shellClass = icon.getAttribute('class') ?? ''
              // The replacement carries the marker too: the outerHTML write
              // itself triggers the observer, and the marker is what keeps
              // the next pass from swapping our own glyph again.
              icon.outerHTML = `<svg data-dsh-sidebar-icon="1" class="${shellClass}" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M5.75 2.75v10.5"/><path d="M3.5 5.75h1.25"/></svg>`
            }
          }
          swap()
          const observer = new MutationObserver(swap)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => { observer.disconnect() }
        } catch (error) {
          fail('settings-nav icon', error)
          return undefined
        }
      },
      'dsh-plugin-vscode-sidebar: settings-nav icon',
    )

    ctx.effect(
      () => {
        try {
          return registerTurnTailInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-plugin-vscode-sidebar: turn-tail interception',
    )

    ctx.effect(
      () => {
        try {
          return registerOpenPathInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-plugin-vscode-sidebar: open-path interception',
    )

    ctx.effect(
      () => {
        try {
          // External http(s) links in the chat/GUI open the sidebar browser
          // instead of a new window (gated on the browserInterceptLinks pref
          // AND the browser tab's enable switch; Ctrl/Cmd+click bypasses).
          return registerLinkInterception({
            takeoverEnabled: () => sidebarStore.getPrefs().browserInterceptLinks !== false
              && sidebarStore.getPrefs().tabsEnabled['browser'] !== false,
            openInSidebar: (url) => {
              let title: string | undefined
              try { title = new URL(url).hostname } catch { /* keep the default title */ }
              ctx.vscodeSidebar?.openTab({ type: 'browser', url, title })
            },
            selfOrigin: window.location.origin,
          })
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-plugin-vscode-sidebar: link interception',
    )

    // The IME guard: composition keys (candidate arrows, confirm, cancel)
    // belong to the input method, never to page JS. Inlined third-party UI
    // (formerly Univer's office controls, #562 regression) has shipped
    // unguarded keydown handlers that hijack ArrowUp/ArrowDown and break
    // Chinese input; the document-capture guard neutralizes the whole class
    // before React or any native listener sees the event. Registered as
    // early as possible so no other capture-phase listener can win the
    // ordering race.
    ctx.effect(
      () => {
        try {
          return registerImeGuard()
        } catch (error) {
          fail('ime guard', error)
          return undefined
        }
      },
      'dsh-plugin-vscode-sidebar: IME composition guard',
    )

    // The "Side card" settings section: appears in the DSH Settings shell
    // once the shell's declaration is on the ledger (slots.inject waits for
    // it); the section reads/writes the prefs through the plugin's own
    // fenced settings route, keeps the shared store in sync, and renders the
    // declarative enable/disable inventory from the tab/viewer registry.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'vscode-sidebar',
      order: 100,
      label: () => t('settingsNav'),
      inject: () => ({ store: sidebarStore, service }),
    }, SideCardSection))
  } catch (error) {
    fail('load', error)
  }
}
