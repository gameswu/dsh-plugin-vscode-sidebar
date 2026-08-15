/**
 * Markdown preview copy-label spec: the fence copy buttons ("复制" / "Copy")
 * must follow the DSH locale service through `codeLabels` — the DSH
 * MarkdownText/CodeBlock are cordis-free and fall back to HARDCODED Chinese
 * when the caller omits the labels, so MarkdownPreview (the surface
 * TextEditor renders) must pass its own dictionary copy (`t('copy')` /
 * `t('copied')`), re-evaluated per render. Rendered with renderToString —
 * the extracted component has no monaco/editor dependency, so no DOM or
 * effects are needed.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement, type RefObject } from 'react'
import './browser-globals.ts'
import { MarkdownPreview } from '../src/client/MarkdownPreview.tsx'
import { attachLocale } from '../src/client/locales.ts'

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'zh'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
}

/** A markdown source with one fenced code block (the copy-button surface). */
const MD_WITH_FENCE = '```ts\nconst a = 1\n```'

/** renderToString-safe renderer (a plain object satisfies RefObject). */
function renderer(text: string): string {
  const ref = { current: null } as RefObject<HTMLDivElement>
  return renderToString(createElement(MarkdownPreview, {
    text,
    mdRef: ref,
    onMouseUp: () => {},
    onScroll: () => {},
  }))
}

afterEach(() => {
  attachLocale(undefined)
})

describe('markdown preview code-block copy labels (DSH i18n following)', () => {
  it('renders the fence copy button with the zh dictionary label by default', () => {
    const locale = new FakeLocale()
    locale.active = 'zh'
    attachLocale(locale)
    const html = renderer(MD_WITH_FENCE)
    expect(html).toContain('复制')
    expect(html).not.toContain('Copy')
  })

  it('follows the attached locale service live: en renders "Copy" instead of the zh label', () => {
    const locale = new FakeLocale()
    locale.active = 'en'
    attachLocale(locale)
    const html = renderer(MD_WITH_FENCE)
    expect(html).toContain('Copy')
    expect(html).not.toContain('复制')
  })
})
