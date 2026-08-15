/**
 * The editor-tab dirty registry: which open editor tabs have UNSAVED
 * changes and how to save them. The tab strip reads it for the VSCode-style
 * dirty dot, the sidebar shell reads it for the close-with-unsaved confirm
 * and the global Ctrl/Cmd+S handler, and the editor view registers its save
 * callback here (keyed by its tab id).
 *
 * Deliberately NOT part of the persisted per-session layout state: a dirty
 * flag is session-live UI state, and a saved-on-disk flag would wrongly
 * survive reloads (the file on disk is the source of truth).
 *
 * SINGLETON BRIDGE: the editor view loads as a LAZY chunk
 * (lib/client-editor.js) whose bundled copy of this module is a SEPARATE
 * module instance from the shell bundle's copy. Two instances would keep
 * two disjoint dirty sets — edits in the chunk would never light the shell's
 * tab dot or arm the close confirm. All state therefore lives on ONE
 * window-scoped object that every bundle copy delegates to.
 */
export type SaveTabFn = () => Promise<boolean> | boolean | void

interface DirtyBridge {
  saves: Map<string, SaveTabFn>
  dirty: Set<string>
  listeners: Set<() => void>
  revision: number
}

/** The shared window-scoped state (created by whichever copy loads first). */
function bridge(): DirtyBridge {
  const root = window as unknown as { __dshSidebarDirty?: DirtyBridge }
  if (root.__dshSidebarDirty === undefined) {
    root.__dshSidebarDirty = {
      saves: new Map(),
      dirty: new Set(),
      listeners: new Set(),
      revision: 0,
    }
  }
  return root.__dshSidebarDirty
}

function notify(): void {
  const state = bridge()
  state.revision += 1
  for (const listener of [...state.listeners]) listener()
}

/** Register one editor tab (its save callback). Returns the disposer; the
 *  tab's dirty flag is cleared on disposal. */
export function registerEditorTab(tabId: string, save: SaveTabFn): () => void {
  const state = bridge()
  state.saves.set(tabId, save)
  return () => {
    state.saves.delete(tabId)
    if (state.dirty.delete(tabId)) notify()
  }
}

/** Flip one editor tab's dirty flag (the dirty dot follows it). */
export function setTabDirty(tabId: string, value: boolean): void {
  const state = bridge()
  const changed = value ? !state.dirty.has(tabId) : state.dirty.delete(tabId)
  if (changed) notify()
}

/** Whether one editor tab has unsaved changes. */
export function isTabDirty(tabId: string): boolean {
  return bridge().dirty.has(tabId)
}

/**
 * Save one tab through its registered callback (no-op for tabs without
 * one). Resolves to whether the save completed.
 */
export async function saveTab(tabId: string): Promise<boolean> {
  const save = bridge().saves.get(tabId)
  if (save === undefined) return false
  try {
    await save()
    return true
  } catch {
    return false
  }
}

/** Subscribe to dirty-set changes (returns the disposer; revision semantics). */
export function subscribeTabDirty(listener: () => void): () => void {
  const state = bridge()
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}

/** Monotonic revision of the dirty set (useSyncExternalStore snapshot). */
export function getTabDirtyRevision(): number {
  return bridge().revision
}

/** The ids of all currently dirty tabs (the global Ctrl/Cmd+S handler). */
export function dirtyTabIds(): readonly string[] {
  return [...bridge().dirty]
}
