/**
 * Explorer create-flow regression tests (jsdom): clicking the header + menu
 * must reveal the inline name input (the #create-vanished regression: a
 * double-rendered input row + autoFocus focus-stealing blurred the first
 * input instantly, whose empty blur committed and unmounted BOTH rows), an
 * empty blur must keep the row alive, Enter commits through fs.create, and
 * Escape cancels without a write.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ExplorerView } from '../src/client/ExplorerView.tsx'

const createCalls: Array<{ path: string; name: string; isDir: boolean }> = []

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

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

/** Mount the explorer over the fake wire with one root level of entries. */
function mountExplorer() {
  return mount(
    createElement(ExplorerView, {
      sessionId: 's1',
      cwd: 'D:/work',
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      visible: true,
    }),
  )
}

beforeEach(() => {
  createCalls.length = 0
  // Pin the locale copy to zh (the assertions below match the zh labels).
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (method === 'fs.tree') {
      return jsonResponse({
        ok: true,
        value: {
          path: body.path,
          entries: [
            { name: 'hello.ts', path: 'D:/work/hello.ts', isDir: false, hidden: false },
          ],
          truncated: false,
        },
      })
    }
    if (method === 'fs.create') {
      createCalls.push({ path: String(body.path), name: String(body.name), isDir: body.isDir === true })
      return jsonResponse({ ok: true, value: { ok: true, path: 'D:/work/x' } })
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

/** The name input currently rendered (create or rename). */
function nameInput(container: HTMLDivElement): HTMLInputElement {
  return container.querySelector('input[aria-label="名称"], input[aria-label="Name"]') as HTMLInputElement
}

/** Click the + anchor, then the menu item with the given label. */
function clickHeaderMenu(container: HTMLDivElement, label: string): void {
  const plus = container.querySelector('button') as HTMLButtonElement
  // Debug guard: the header + button must exist (root is defined).
  expect(plus).not.toBeNull()
  act(() => { plus.click() })
  const items = [...document.body.querySelectorAll('button[role="menuitem"]')]
  const item = items.find(candidate => candidate.textContent === label)
  expect(item).toBeDefined()
  act(() => { (item as HTMLButtonElement).click() })
}

describe('ExplorerView create flow', () => {
  it('reveals the inline name input after the header menu selection', async () => {
    const { container, unmount } = mountExplorer()
    await act(async () => {})
    expect(nameInput(container)).toBeNull()
    clickHeaderMenu(container, '新文件')
    const input = nameInput(container)
    // The regression: the input vanished instantly (double row + focus steal
    // + empty-blur commit). Exactly ONE input row must stay mounted.
    expect(input).not.toBeNull()
    expect(container.querySelectorAll('input[aria-label]')).toHaveLength(1)
    // An empty blur (clicking away without typing) keeps the row alive.
    act(() => { input!.blur() })
    expect(nameInput(container)).not.toBeNull()
    // Enter commits through fs.create with the typed name.
    input!.value = 'new-file.txt'
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {})
    expect(createCalls).toEqual([{ path: 'D:/work', name: 'new-file.txt', isDir: false }])
    // The row unmounts after the commit.
    expect(nameInput(container)).toBeNull()
    unmount()
  })

  it('creates a folder via the menu and cancels with Escape', async () => {
    const { container, unmount } = mountExplorer()
    await act(async () => {})
    clickHeaderMenu(container, '新建文件夹')
    const input = nameInput(container)
    expect(input).not.toBeNull()
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {})
    expect(nameInput(container)).toBeNull()
    expect(createCalls).toEqual([])
    unmount()
  })
})
