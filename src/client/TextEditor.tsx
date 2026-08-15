/**
 * The code/markdown/html file viewer: the STANDARD VSCode editor (Monaco)
 * with syntax highlighting for every language monaco ships (the package's
 * full language-definition set is registered in the editor chunk), line
 * wrapping, preview/edit toggle for markdown/html, a VSCode-style dirty dot
 * on the tab title (via the dirty-tabs registry), Ctrl/Cmd+S save, and a
 * selection popup ("add to conversation") for the code viewer. Registered
 * as the `code` (catch-all), `markdown` and `html` built-in viewers; the
 * editor tab host fetches the content through the fsRead strategy and
 * passes it in props, so this component never fetches or dispatches — it
 * only edits.
 *
 * The toolbar (mode toggle / save / status) renders as its own row below
 * the host's title bar, VSCode-style. Monaco lives entirely in the lazy
 * editor chunk (see chunks/editor.tsx), which also wires
 * MonacoEnvironment to the plugin-served editor worker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import { api } from './api.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { HtmlPreview } from './HtmlPreview.tsx'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { registerEditorTab, setTabDirty } from './dirty-tabs.ts'
import { t } from './locales.ts'
import type { FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/** The floating "add to conversation" action: payload + viewport anchor. */
interface SelectionPopup {
  insert: string
  left: number
  top: number
}

export function TextEditor(props: FileViewerProps) {
  const { ctx, scope, path, viewerId, content, truncated, tabId } = props
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const savingRef = useRef(false)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The floating "add to conversation" popup (viewport-anchored; null = hidden). */
  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)
  /** Live save() for the registry/effect closures (stable across renders). */
  const saveRef = useRef<() => Promise<boolean>>(async () => false)

  const hidePopup = useCallback((): void => {
    popupRef.current = null
    setPopup(null)
  }, [])

  /** Anchor the popup above the selection center; clamp inside the viewport. */
  const showPopup = useCallback((insert: string, left: number, top: number): void => {
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
    }
    popupRef.current = next
    setPopup(next)
  }, [])

  /** The popup button's click: insert the stored payload into the draft. */
  const commitPopup = (): void => {
    const current = popupRef.current
    if (current === null) return
    appendToDraft(ctx, scope.sessionId, current.insert)
    hidePopup()
  }

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch) starts clean: fresh preview mode, no draft.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setSaveState('idle')
    hidePopup()
  }, [content, hidePopup])

  /**
   * Save the current Monaco model through the host fs.write route; clears
   * the draft and the tab's dirty dot on success. Resolves to whether the
   * file was actually written (the close-confirm only closes on true).
   */
  const save = useCallback(async (): Promise<boolean> => {
    const editor = editorRef.current
    if (editor === null || savingRef.current) return false
    const model = editor.getModel()
    if (model === null) return false
    savingRef.current = true
    setSaveState('saving')
    try {
      await api.fsWrite(scope, path, model.getValue())
      setDraft(null)
      if (tabId !== undefined) setTabDirty(tabId, false)
      setSaveState('saved')
      return true
    } catch {
      setSaveState('failed')
      return false
    } finally {
      savingRef.current = false
    }
  }, [scope, path, tabId])

  useEffect(() => { saveRef.current = save }, [save])

  // The tab shell saves this tab on close-confirm / global Ctrl+S.
  useEffect(() => {
    if (tabId === undefined) return
    return registerEditorTab(tabId, () => saveRef.current())
  }, [tabId])

  // Create the Monaco editor once the content is loaded. Monaco owns the
  // document; React only tracks dirty/draft state through the content
  // listener. For markdown/html the editor stays mounted while previewing
  // (hidden), so unsaved edits survive the preview/edit toggle. The
  // language resolves from the file:// URI's extension against every
  // language monaco registered (the chunk imports the full definition set).
  useEffect(() => {
    if (content === undefined) return
    const host = hostRef.current
    if (host === null) return
    const model = monaco.editor.createModel(
      content,
      undefined,
      monaco.Uri.parse(`file:///${path.replace(/\\/g, '/')}`),
    )
    const editor = monaco.editor.create(host, {
      model,
      theme: isDarkScheme() ? 'vs-dark' : 'vs',
      automaticLayout: true,
      wordWrap: 'on',
      tabSize: 2,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
    })
    editorRef.current = editor
    const contentSub = model.onDidChangeContent(() => {
      const text = model.getValue()
      setDraft(text)
      if (tabId !== undefined) setTabDirty(tabId, text !== content)
    })
    // VSCode's Ctrl/Cmd+S: save through the host route.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current() })
    // Selection popup (the catch-all code viewer only): a non-empty
    // selection anchors the floating "add to conversation" button above
    // its head. Scrolling or losing focus hides it; typing collapses the
    // selection and hides it too (the content listener above does not —
    // selection collapses, so the selection listener hides it).
    const selectionSub = editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection()
      if (selection === null || selection.isEmpty()) {
        hidePopup()
        return
      }
      const text = model.getValueInRange(selection)
      if (text.trim() === '') {
        hidePopup()
        return
      }
      const pos = editor.getScrolledVisiblePosition(selection.getStartPosition())
      const hostRect = host.getBoundingClientRect()
      if (pos === null || hostRect === null) {
        hidePopup()
        return
      }
      showPopup(
        buildSelectionInsert(path, scope.cwd, {
          start: selection.startLineNumber,
          end: selection.endLineNumber,
        }, text),
        hostRect.left + pos.left + 12,
        hostRect.top + pos.top,
      )
    })
    const blurSub = editor.onDidBlurEditorText(() => { hidePopup() })
    return () => {
      selectionSub.dispose()
      blurSub.dispose()
      contentSub.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // The command's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the re-theme effect
    // below (recreating the editor here would drop the draft).
  }, [content, path, tabId, hidePopup, showPopup])

  // Scheme flip: re-theme in place.
  useEffect(() => {
    editorRef.current?.updateOptions({ theme: dark ? 'vs-dark' : 'vs' })
  }, [dark])

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again. A mode flip also invalidates any anchored
  // selection popup.
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') editorRef.current?.layout()
  }, [mode, hidePopup])

  /**
   * Selection popup for the markdown preview: a mouse-up inside the preview
   * container anchors the floating "add to conversation" button above the
   * selection. Line numbers come from a best-effort reverse-search of the
   * selected text in the source ({@link linesOfSelection} — an ambiguous or
   * missing hit omits them). The button's own mousedown preventDefaults so
   * the selection survives until the click commits.
   */
  const handlePreviewMouseUp = (): void => {
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed || sel.anchorNode === null || sel.focusNode === null) {
      hidePopup()
      return
    }
    const host = mdRef.current
    if (host === null || !host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) {
      hidePopup()
      return
    }
    const text = sel.toString()
    if (text.trim() === '') {
      hidePopup()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const lines = linesOfSelection(draft ?? content ?? '', text)
    showPopup(
      buildSelectionInsert(path, scope.cwd, lines ?? undefined, text),
      rect.left + rect.width / 2,
      rect.top,
    )
  }
  const editable = content !== undefined
  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'

  return (
    <>
      <div className={css.editorHeader}>
        {(markdown || html) && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {saveState === 'failed' && <span className={clsx(css.editorStatus, css.editorStatusError)}>{t('saveFailed')}</span>}
        {/* Saving is Ctrl/Cmd+S only — no toolbar button (the dirty dot and
            the close-time prompt carry the unsaved affordance instead). */}
        <span className={css.editorSaveHint}>{t('saveShortcut')}</span>
      </div>
      {editable && (
        <>
          {truncated === true && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, (markdown || html) && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {markdown && mode === 'preview' && (
        <MarkdownPreview
          text={draft ?? content ?? ''}
          mdRef={mdRef}
          onMouseUp={handlePreviewMouseUp}
          onScroll={hidePopup}
          scope={scope}
          path={path}
          ctx={ctx}
        />
      )}
      {html && mode === 'preview' && (
        <HtmlPreview scope={scope} path={path} store={props.store} />
      )}
      {popup !== null && createPortal(
        <button
          type="button"
          className={css.selectionPopup}
          style={{ left: popup.left, top: popup.top }}
          // Keep the selection (and editor focus) alive until the click
          // commits — without this the popup unmounts before click lands.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={commitPopup}
        >
          {t('addToConversation')}
        </button>,
        document.body,
      )}
    </>
  )
}
