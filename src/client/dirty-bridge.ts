/**
 * The unsaved-tab bridge: ONE window-scoped registry that every bundle copy
 * shares — the shell bundle, the lazily-loaded editor chunk, and any future
 * bundle all delegate to the same window object, so a dirty write from the
 * chunk is ALWAYS visible to the shell regardless of bundle versions or
 * module duplication. The store mirrors the bridge's revision into its
 * snapshot (the React re-render trigger); the editor chunk calls these
 * functions DIRECTLY (its bundled copy reaches the same window object).
 */
export type SaveTabFn = () => Promise<boolean> | boolean | void

interface DirtyBridge {
  saves: Map<string, SaveTabFn>
  dirty: Set<string>
  listeners: Set<() => void>
  revision: number
}

/** Non-browser fallback state (node tests / SSR): one per module copy, which
 *  is exactly right — without a window there are no cross-bundle copies to
 *  reconcile. */
let fallback: DirtyBridge | undefined

/** The shared window-scoped state (created by whichever copy loads first). */
export function dirtyBridge(): DirtyBridge {
  if (typeof window === 'undefined') {
    if (fallback === undefined) {
      fallback = { saves: new Map(), dirty: new Set(), listeners: new Set(), revision: 0 }
    }
    return fallback
  }
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
  const state = dirtyBridge()
  state.revision += 1
  for (const listener of [...state.listeners]) listener()
}

/** Whether one editor tab has unsaved changes. */
export function isDirty(tabId: string): boolean {
  return dirtyBridge().dirty.has(tabId)
}

/** Flip one editor tab's dirty flag (the tab strip's dot follows it).
 *  NOTE: the flag must actually MUTATE the set — an earlier implementation
 *  only EVALUATED whether a change was due (`value ? !has : delete`) without
 *  ever adding the id, so the dirty dot/save-prompt never lit. */
export function setDirty(tabId: string, value: boolean): void {
  const state = dirtyBridge()
  const had = state.dirty.has(tabId)
  if (value) {
    if (had) return
    state.dirty.add(tabId)
  } else {
    if (!had) return
    state.dirty.delete(tabId)
  }
  notify()
}

/** Register one editor tab's save callback; the dirty flag clears on disposal. */
export function registerSave(tabId: string, save: SaveTabFn): () => void {
  const state = dirtyBridge()
  state.saves.set(tabId, save)
  return () => {
    state.saves.delete(tabId)
    if (state.dirty.delete(tabId)) notify()
  }
}

/** Save one tab through its registered callback; resolves to success. */
export async function saveTab(tabId: string): Promise<boolean> {
  const save = dirtyBridge().saves.get(tabId)
  if (save === undefined) return false
  try {
    await save()
    return true
  } catch {
    return false
  }
}

/** Subscribe to dirty-set changes (returns the disposer). */
export function subscribeDirty(listener: () => void): () => void {
  const state = dirtyBridge()
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}

/** Monotonic revision of the dirty set. */
export function dirtyRevision(): number {
  return dirtyBridge().revision
}
