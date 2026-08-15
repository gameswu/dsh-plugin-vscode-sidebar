/**
 * The markdown preview surface (extracted from TextEditor so the copy-label
 * guarantee is testable without pulling the monaco editor stack): renders
 * the DSH MarkdownText with THIS plugin's dictionary copy for the fence
 * copy buttons — the DSH MarkdownText/CodeBlock are cordis-free and fall
 * back to hardcoded Chinese when the caller omits the labels. Render-time
 * t() keeps the labels following the active locale on live switches.
 *
 * Local-document affordances (the viewer contract, not the chat renderer):
 * - RELATIVE links rewrite to a synthetic https anchor the renderer accepts,
 *   and a click handler resolves them back to the file they named, opening
 *   it through the chat-side file-open funnel (`ctx.workspaces.openPath` —
 *   which itself lands in the sidebar editor when the interception pref is
 *   on). Absolute HTTP(S) links keep rendering and keep the browser's
 *   default behavior.
 * - RELATIVE images rewrite to the host's media route (absolute URL), so
 *   `![diagram](./diagram.png)` renders from the document's directory.
 * - Inline-code file mentions resolve through `fileMentions` against the
 *   document directory's real listing (one fs.tree call), so a token that
 *   names an actual sibling file becomes an opener; every other token stays
 *   inert code. Math already renders through the DSH renderer's KaTeX.
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type RefObject } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, mediaUrl, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import type { Context } from '../context-types.ts'
import css from './sidebar.module.css'

/** The synthetic host of rewritten relative file links (never resolved by
 *  the browser: the container's click handler intercepts them). */
const FILE_LINK_ORIGIN = 'https://dsh-sidebar-file.invalid'

/** Parent directory of a path (mixed-separator tolerant). */
function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.lastIndexOf('/')
  if (at <= 0) return path
  const parent = normalized.slice(0, at)
  return parent.length === 2 && parent[1] === ':' ? `${parent}/` : parent
}

/** Whether a link/image destination is a LOCAL path (no scheme, no //, no #). */
function isLocalTarget(destination: string): boolean {
  if (destination === '' || destination.startsWith('#') || destination.startsWith('//')) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)
}

/** Strip a fragment/query off a local target (they are not part of the path). */
function stripFragment(target: string): string {
  const hash = target.indexOf('#')
  const query = target.indexOf('?')
  const cut = Math.min(hash === -1 ? Infinity : hash, query === -1 ? Infinity : query)
  return cut === Infinity ? target : target.slice(0, cut)
}

/** Resolve a local target against the document's directory (host-native shape). */
function resolveLocal(target: string, baseDir: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '')
  let base = baseDir.replace(/\\/g, '/').replace(/\/$/, '')
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
  for (const part of parts) {
    if (part === '..') {
      const at = base.lastIndexOf('/')
      base = at <= 0 ? base : base.slice(0, at)
    } else {
      base += `/${part}`
    }
  }
  return base
}

/** Link/image syntax at the document level: ![alt](dest "title") / [text](dest). */
const MD_LINK_IMAGE = /(!)?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/**
 * Rewrite local link/image destinations for the viewer:
 * relative links → a synthetic https anchor the click handler intercepts;
 * relative images → the absolute media-route URL.
 */
function localizeMarkdown(
  text: string,
  baseDir: string,
  scope: SessionScope | undefined,
): string {
  return text.replace(MD_LINK_IMAGE, (match, image: string | undefined, label: string, destination: string) => {
    if (!isLocalTarget(destination)) return match
    const target = resolveLocal(stripFragment(destination), baseDir)
    if (image === '!') {
      if (scope === undefined) return match
      const url = new URL(mediaUrl(scope, target), window.location.origin).toString()
      return `![${label}](${url})`
    }
    return `[${label}](${FILE_LINK_ORIGIN}/?p=${encodeURIComponent(target)})`
  })
}

export function MarkdownPreview(props: {
  text: string
  mdRef: RefObject<HTMLDivElement>
  /** Anchors the selection popup (best-effort line lookup). */
  onMouseUp: () => void
  /** Hides the selection popup while the preview scrolls. */
  onScroll: () => void
  /** The viewer's session scope (enables relative images + file jumps). */
  scope?: SessionScope
  /** The previewed document's absolute path (the base of relative targets). */
  path?: string
  /** The client context (the chat-side file-open funnel). */
  ctx?: Context
}) {
  const { text, mdRef, onMouseUp, onScroll, scope, path, ctx } = props

  /** Sibling entries of the document directory (name → absolute path). */
  const [siblings, setSiblings] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (scope === undefined || path === undefined) return
    api.fsTree(scope, parentDir(path)).then((listing) => {
      const map = new Map<string, string>()
      for (const entry of listing.entries) map.set(entry.name, entry.path)
      setSiblings(map)
    }).catch(() => { /* a failed listing keeps mentions inert */ })
  }, [scope, path])

  /** Open one absolute path through the chat-side file-open funnel. */
  const openPath = useCallback((target: string): void => {
    void ctx?.workspaces.openPath(target)
  }, [ctx])

  /** Inline-code file mentions: tokens naming a sibling file (or a path whose
   *  first segment is a sibling directory) become openers; everything else
   *  stays inert code. */
  const fileMentions = useMemo(() => (siblings.size === 0 ? undefined : ({
    resolve: (value: string) => {
      if (value.includes('://') || value.includes('\\0')) return undefined
      const segments = value.split('/').filter(part => part !== '' && part !== '.')
      const head = segments[0]
      if (head === undefined) return undefined
      const first = siblings.get(head)
      if (first === undefined) return undefined
      const target = segments.length === 1
        ? first
        : `${first.replace(/\\/g, '/').replace(/\/$/, '')}/${segments.slice(1).join('/')}`
      return { label: value, title: target, open: () => { openPath(target) } }
    },
  })), [siblings, openPath])

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as Node | null
    const anchor = target instanceof Element ? target.closest('a') : null
    if (anchor === null) return
    if (!anchor.href.startsWith(`${FILE_LINK_ORIGIN}/?p=`)) return
    event.preventDefault()
    const encoded = anchor.href.slice(`${FILE_LINK_ORIGIN}/?p=`.length)
    try {
      openPath(decodeURIComponent(encoded))
    } catch {
      // A malformed target: do nothing (the anchor stays inert).
    }
  }

  const localized = useMemo(
    () => (path === undefined ? text : localizeMarkdown(text, parentDir(path), scope)),
    [text, path, scope],
  )

  return (
    <div
      className={css.editorMd}
      ref={mdRef}
      onMouseUp={onMouseUp}
      onScroll={onScroll}
      onClick={onClick}
    >
      <MarkdownText
        text={localized}
        codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}
        fileMentions={fileMentions}
      />
    </div>
  )
}
