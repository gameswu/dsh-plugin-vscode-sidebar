/**
 * The HTML preview surface (extracted from TextEditor so the sandbox
 * contract is testable without pulling the monaco editor stack): the
 * route-src iframe plus the live sandbox status row.
 *
 * Route-src (never srcdoc — a srcdoc frame inherits the parent origin when
 * unsandboxed; the route URL keeps the frame cross-origin by construction).
 * The preview shows the SAVED file; the editor's draft is only visible in
 * edit mode.
 */
import { useState } from 'react'
import { htmlUrl, type SessionScope } from './api.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { HTML_IFRAME_SANDBOX } from './sandbox.ts'
import type { SidebarStore } from './state.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function HtmlPreview(props: {
  scope: SessionScope
  path: string
  store: SidebarStore
}) {
  // Per-feature sandbox escape hatch: the global side card setting (warned)
  // plus a per-surface temporary unlock. The unlock state starts at the
  // "default unsafe" pref so a preview can open straight into the red
  // unsandboxed state (still restorable from the status row).
  const [localUnlock, setLocalUnlock] = useState(() => props.store.getPrefs().htmlViewerDefaultUnsafe === true)
  const htmlNoSandbox = props.store.getPrefs().htmlViewerNoSandbox === true || localUnlock
  return (
    <>
      <SandboxStatusBar
        sandboxed={!htmlNoSandbox}
        local={localUnlock}
        dangerCopy={t('htmlNoSandboxWarning')}
        onUnlock={() => { setLocalUnlock(true) }}
        onRestore={() => { setLocalUnlock(false) }}
      />
      <iframe
        className={css.editorHtml}
        src={htmlUrl(props.scope, props.path)}
        sandbox={htmlNoSandbox ? undefined : HTML_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
        title={props.path}
      />
    </>
  )
}
