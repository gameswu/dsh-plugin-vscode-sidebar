/**
 * The unsaved-tab bridge regression suite: the dirty registry lives on ONE
 * window-scoped object. The lazy editor chunk (a separate bundle copy of
 * the module) writes through the same window object, the store mirrors the
 * bridge revision into its snapshot (the shell's re-render trigger), and
 * the tab strip renders the dot from the store's read. These tests model
 * the exact cross-bundle scenario that previously kept the dot dark:
 * a "chunk-side" write through the bridge must light the store's read and
 * a TabBar rendered with the store-backed resolver.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createSidebarStore } from '../src/client/state.ts'
import { dirtyRevision, isDirty, registerSave, saveTab, setDirty, subscribeDirty } from '../src/client/dirty-bridge.ts'
import { TabBar } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, unmount }
}

afterEach(() => {
  // The bridge lives on the window: reset it between tests.
  const root = window as unknown as { __dshSidebarDirty?: unknown }
  delete root.__dshSidebarDirty
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('unsaved-tab bridge', () => {
  it('tracks dirty flags, save callbacks and revision changes', async () => {
    expect(isDirty('tab:1')).toBe(false)
    let notified = 0
    const off = subscribeDirty(() => { notified += 1 })
    const rev0 = dirtyRevision()
    setDirty('tab:1', true)
    expect(isDirty('tab:1')).toBe(true)
    expect(dirtyRevision()).toBe(rev0 + 1)
    expect(notified).toBe(1)
    // Same-value writes never bump the revision.
    setDirty('tab:1', true)
    expect(dirtyRevision()).toBe(rev0 + 1)
    // The registered save runs and the disposer clears the flag.
    const saves: string[] = []
    const unregister = registerSave('tab:1', async () => { saves.push('saved'); return true })
    expect(await saveTab('tab:1')).toBe(true)
    expect(saves).toEqual(['saved'])
    unregister()
    expect(isDirty('tab:1')).toBe(false)
    // A missing tab has nothing to save.
    expect(await saveTab('tab:nope')).toBe(false)
    off()
  })

  it('mirrors bridge writes into the store snapshot (chunk → shell visibility)', () => {
    const store = createSidebarStore()
    const revisions: number[] = []
    const off = store.subscribe(() => { revisions.push(store.getSnapshot().dirtyRevision) })
    // The "chunk side" writes straight through the bridge (a different
    // bundle copy reaches the same window object).
    setDirty('editor:D:/work/a.ts', true)
    expect(store.isTabDirty('editor:D:/work/a.ts')).toBe(true)
    expect(store.getSnapshot().dirtyRevision).toBeGreaterThan(0)
    expect(revisions.at(-1)).toBe(store.getSnapshot().dirtyRevision)
    // The store's own write path hits the same registry.
    store.setTabDirty('editor:D:/work/a.ts', false)
    expect(isDirty('editor:D:/work/a.ts')).toBe(false)
    off()
    store.dispose()
  })

  it('renders the tab dirty dot from the store-backed resolver', () => {
    const store = createSidebarStore()
    const tabs: SidebarTab[] = [{ id: 'editor:x', type: 'editor', title: 'x.ts' }]
    setDirty('editor:x', true)
    const render = (): void => {
      act(() => {
        root.render(createElement(TabBar, {
          paneId: 'pane:1',
          tabs,
          active: 'editor:x',
          onActivate: () => {},
          onClose: () => {},
          onNewTab: () => {},
          newTabOptions: [],
          onDropTab: () => {},
          isDirty: tabId => store.isTabDirty(tabId),
        }))
      })
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    render()
    expect(container.querySelector('[class*="tabDirtyDot"]')).not.toBeNull()
    // The bridge clear + a shell re-render (the store notifies on every
    // flip; this render models that) removes the dot.
    setDirty('editor:x', false)
    render()
    expect(container.querySelector('[class*="tabDirtyDot"]')).toBeNull()
    act(() => { root.unmount() })
    container.remove()
    store.dispose()
  })
})

// Silence the unused-import warning for vi in this file (kept for future async work).
void vi
