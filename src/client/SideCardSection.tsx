/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 * The plugin's deployment-level configuration (host limits + preference
 * defaults) lives on the OFFICIAL plugin-config page through the exported
 * Config schema — this section only carries the live session preferences.
 *
 * The section is DECLARATIVE — it renders the enable/disable inventory from
 * the sidebar service's tab registry instead of hardcoding rows:
 *  - 常规: new conversations open the panel by default (a toggle row), the
 *    default panel width as a percent of the window (number input row), and
 *    the open-path interception toggle — the DSH settings-row recipe
 *    (title/desc left + control right, hairline separators).
 *  - 侧边栏内容: one LIST ROW per registered, user-facing tab type (hidden
 *    internal pages like editor/diff are excluded) — icon + title + type id,
 *    an enable switch, and a gear for features that declare related
 *    settings. No viewer inventory and no "add plugin" cards: previewers
 *    are not user-configurable pages and new tabs come from plugins
 *    directly through the service registry.
 *
 * Writes ride the plugin's own fenced settings route (the host calls the
 * settings seam in-process — the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients); the shared SidebarStore
 * is refreshed on success so the very next brand-new session seeds from the
 * new values and the sidebar's consumption points (the + menu, derived
 * flows) re-render immediately. Any failure reverts the optimistic UI and
 * shows the wire error inline — a broken settings surface never crashes the
 * shell.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconSettingsOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  clampWidthPercent,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from '../prefs-shared.ts'
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'
import { t } from './locales.ts'
import type { SidebarStore } from './state.ts'
import type {
  VscodeSidebarService,
  FileViewerDescriptor,
  SidebarSettingsRenderProps,
  SidebarSettingToggle,
  TabDescriptor,
} from './service.ts'
import css from './SideCardSection.module.css'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface SideCardSectionInjected {
  store: SidebarStore
  service: VscodeSidebarService
}

/** Full section props: the runtime share plus the injected face. */
export type SideCardSectionProps = PropsRuntime<'settings.section'> & SideCardSectionInjected

/** Map one wire failure to the inline message (the conflict gets friendly copy). */
function messageOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'settings-conflict') {
    return `${t('settingsSaveFailed')} ${t('settingsConflict')}`
  }
  return `${t('settingsSaveFailed')} ${error instanceof Error ? error.message : String(error)}`
}

/** Resolve an i18n-friendly string-or-function value. */
function textOf(value: string | (() => string) | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'function' ? value() : value
}

/** Resolve a descriptor icon (ReactNode or size function). */
function iconOf(icon: ReactNode | ((size: number) => ReactNode) | undefined, size: number): ReactNode {
  if (icon === undefined) return null
  return typeof icon === 'function' ? icon(size) : icon
}

/** Tab inventory order: the + menu order (hidden internal pages never list). */
function tabOrder(a: TabDescriptor, b: TabDescriptor): number {
  return (a.order ?? 100) - (b.order ?? 100)
}

/** Whether a feature declares any secondary settings (gear button shows). */
function hasSettings(feature: TabDescriptor | FileViewerDescriptor): boolean {
  const settings = feature.settings
  return settings !== undefined && (
    (settings.toggles?.length ?? 0) > 0
    || (settings.pluginToggles?.length ?? 0) > 0
    || settings.render !== undefined
  )
}

/** A feature's display name (viewers fall back to their id). */
function featureNameOf(feature: TabDescriptor | FileViewerDescriptor): string {
  return textOf('title' in feature ? feature.title : undefined) || feature.id
}

/**
 * Merge one plugin-owned setting into a pluginSettings map (pure, v0.12.0+).
 * Sequential merges are additive: each call spreads the map it was GIVEN,
 * so building from the latest optimistic map keeps earlier keys intact
 * (two same-tick writes must not drop each other).
 */
export function mergePluginSetting(
  pluginSettings: Record<string, Record<string, unknown>>,
  descriptorId: string,
  key: string,
  value: unknown,
): Record<string, Record<string, unknown>> {
  return {
    ...pluginSettings,
    [descriptorId]: { ...(pluginSettings[descriptorId] ?? {}), [key]: value },
  }
}

/**
 * Render a custom settings panel (`settings.render`) with error containment:
 * a throwing panel shows an inline error line instead of breaking the whole
 * settings page.
 */
function SettingsRender(props: {
  render: (renderProps: SidebarSettingsRenderProps) => ReactNode
  renderProps: SidebarSettingsRenderProps
}) {
  let content: ReactNode
  try {
    content = props.render(props.renderProps)
  } catch (error) {
    content = (
      <div className={css.error} role="alert">
        {t('settingsSaveFailed')} {error instanceof Error ? error.message : String(error)}
      </div>
    )
  }
  return <>{content}</>
}

/**
 * The custom switch: a real checkbox (hidden, native semantics and focus)
 * driving a styled track/thumb. Used by the general toggle rows and the
 * secondary settings popup rows.
 */
function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  const { checked, onChange, label } = props
  return (
    <label className={css.switch}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={checked}
        aria-label={label}
        onChange={event => { onChange(event.currentTarget.checked) }}
      />
      <span className={css.switchTrack} aria-hidden="true">
        <span className={css.switchThumb} />
      </span>
    </label>
  )
}

/**
 * The body of a feature's secondary settings popup: one row (title/desc +
 * control) per declared setting. Switches render the custom switch; text and
 * number rows render a free-form / numeric input committed on blur/Enter
 * (clamped to the declared min/max). Extracted so the rows are testable
 * without opening the Modal (the Modal portal renders only while open).
 */
export function FeatureSettingsRows(props: {
  toggles: readonly SidebarSettingToggle[]
  prefs: SidebarPrefs
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  /** Commit one text/number row; returns the canonical value the row should
   *  display (clamped for numbers, the current pref when the input is
   *  invalid). Optional: rows with no handler keep their draft. */
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
  /** Explicit value source (v0.12.0+): when given, rows read their values
   *  from it instead of the `prefs` face — plugin-owned rows read their
   *  own blob, so a plugin key can never collide with (or silently read)
   *  a host pref of the same name. (Named `valueSource`, not `valueOf`:
   *  the latter collides with the inherited Object.prototype.valueOf.) */
  valueSource?: (key: string) => unknown
}) {
  const { toggles, prefs, onToggle, onCommit, valueSource } = props
  const read = valueSource ?? ((key: string): unknown => (prefs as unknown as Record<string, unknown>)[key])
  return (
    <div className={css.popupRows}>
      {toggles.map(toggle => {
        const title = textOf(toggle.title)
        if ((toggle.type ?? 'switch') === 'switch') {
          return (
            <div key={toggle.key} className={css.popupRow}>
              <span className={css.rowText}>
                <span className={css.title}>{title}</span>
                {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
              </span>
              <Switch
                label={title}
                checked={read(toggle.key) === true}
                onChange={(next) => { onToggle(toggle, next) }}
              />
            </div>
          )
        }
        const value = String(read(toggle.key) ?? '')
        // Keyed by the committed value: a failed commit reverts prefs, the
        // key changes, and the row remounts with the stored value (typing
        // never changes the key, so mid-edit drafts survive re-renders).
        return (
          <TypedRow
            key={`${toggle.key}:${value}`}
            toggle={toggle}
            title={title}
            value={value}
            onCommit={onCommit}
          />
        )
      })}
    </div>
  )
}

/**
 * One text/number row: a controlled input whose draft is local state,
 * committed on blur/Enter through the parent's onCommit. The parent's
 * canonical return is adopted (clamped numbers, stored value for invalid
 * input); a `unit` suffix renders after the input (e.g. 'px').
 */
function TypedRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: string
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
}) {
  const { toggle, title, value, onCommit } = props
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const canonical = onCommit?.(toggle, draft) ?? draft
    setDraft(canonical)
  }
  const number = toggle.type === 'number'
  return (
    <div className={css.popupRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      <span className={css.control}>
        <Input
          type={number ? 'number' : 'text'}
          className={number ? css.typedInputNumber : css.typedInput}
          value={draft}
          min={toggle.min}
          max={toggle.max}
          step={1}
          placeholder={toggle.placeholder}
          aria-label={title}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {toggle.unit !== undefined && <span className={css.suffix}>{toggle.unit}</span>}
      </span>
    </div>
  )
}

/**
 * The secondary settings popup body of one feature (tab or viewer):
 * - `settings.render` (custom panel) when declared — rendered with the
 *   shared store/service, the live prefs, the descriptor's own plugin
 *   settings blob, a persistence helper, and a close callback;
 * - otherwise the host-prefs `toggles` rows, then the plugin-owned
 *   `pluginToggles` rows (their values live in `pluginSettings[feature.id]`,
 *   projected onto the prefs face so the shared row renderer reads them).
 */
export function SettingsBody(props: {
  feature: TabDescriptor | FileViewerDescriptor
  prefs: SidebarPrefs
  store: SidebarStore
  service: VscodeSidebarService
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onCommit: (toggle: SidebarSettingToggle, raw: string) => string
  onPluginToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onPluginCommit: (toggle: SidebarSettingToggle, raw: string) => string
  onPluginWrite: (key: string, value: unknown) => void
  onClose: () => void
}) {
  const { feature, prefs, store, service, onToggle, onCommit, onPluginToggle, onPluginCommit, onPluginWrite, onClose } = props
  const render = feature.settings?.render
  if (render !== undefined) {
    return (
      <SettingsRender
        render={render}
        renderProps={{
          store,
          service,
          prefs,
          pluginSettings: prefs.pluginSettings[feature.id] ?? {},
          updatePluginSetting: onPluginWrite,
          close: onClose,
        }}
      />
    )
  }
  const toggles = feature.settings?.toggles ?? []
  const pluginToggles = feature.settings?.pluginToggles ?? []
  if (toggles.length === 0 && pluginToggles.length === 0) return null
  // Plugin rows read their values from the descriptor's OWN blob through
  // an explicit value source — no projection onto the prefs face, so a
  // plugin key can never collide with (or silently read) a host pref of
  // the same name.
  const pluginBlob = prefs.pluginSettings[feature.id] ?? {}
  return (
    <div className={css.popupRows}>
      {toggles.length > 0 && (
        <FeatureSettingsRows
          toggles={toggles}
          prefs={prefs}
          onToggle={onToggle}
          onCommit={onCommit}
        />
      )}
      {pluginToggles.length > 0 && (
        <FeatureSettingsRows
          toggles={pluginToggles}
          prefs={prefs}
          onToggle={onPluginToggle}
          onCommit={onPluginCommit}
          valueSource={(key) => pluginBlob[key]}
        />
      )}
    </div>
  )
}

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store/service).
 * @returns the section element tree.
 */
export function SideCardSection({ store, service }: SideCardSectionProps) {
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  const [widthDraft, setWidthDraft] = useState<string>(String(store.getPrefs().defaultWidthPercent))
  const [error, setError] = useState<string | null>(null)
  // Which feature's secondary settings popup is open (null = closed).
  const [settingsFor, setSettingsFor] = useState<TabDescriptor | FileViewerDescriptor | null>(null)
  // The LATEST optimistic prefs, kept in sync with the state. Nested-map
  // merges (tabsEnabled / viewersEnabled / pluginSettings) MUST build from
  // this ref, not from the render-time `prefs`: two same-tick writes (e.g.
  // a settings panel updating several plugin keys at once) would otherwise
  // both spread the stale map and the later patch would drop the earlier
  // key even though the commits are serialized.
  const optimisticRef = useRef(prefs)
  useEffect(() => { optimisticRef.current = prefs }, [prefs])

  // The declarative inventory: the registered tab types (hidden internal
  // pages — editor/diff — never list). Local state + service.subscribe
  // (registry changes are rare — plugin load/unload — so a plain effect is
  // enough; no external-store ceremony).
  const [tabs, setTabs] = useState<TabDescriptor[]>(() => service.getTabs().filter(tab => !tab.hidden).sort(tabOrder))
  useEffect(() => service.subscribe(() => {
    setTabs(service.getTabs().filter(tab => !tab.hidden).sort(tabOrder))
  }), [service])

  // The settings document revision (guards concurrent writes). A ref: commits
  // read the freshest value at execution time, no re-render needed.
  const revisionRef = useRef<number | undefined>(undefined)
  // Whether the user already wrote since mount: the mount read must not
  // clobber a newer optimistic edit (the window is milliseconds, but a slow
  // route must never silently revert a just-made change).
  const dirtyRef = useRef(false)
  // Serialize commits: a queued write must observe the previous write's
  // revision; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  // Sync the persisted document once on mount: the revision and the current
  // values (another tab may have changed them since the store hydrated).
  useEffect(() => {
    let cancelled = false
    void api.settingsGet().then((view) => {
      if (cancelled) return
      revisionRef.current = view.revision
      if (dirtyRef.current) return
      const next = parsePrefs(view.value)
      setPrefs(next)
      setWidthDraft(String(next.defaultWidthPercent))
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [])

  /** Persist one patch through the settings route (serialized, revision-guarded). */
  const commit = (patch: Record<string, unknown>): Promise<{ ok: boolean; prefs: SidebarPrefs }> => {
    dirtyRef.current = true
    const run = inFlightRef.current.then(async () => {
      const view = await api.settingsUpdate(
        { ...patch },
        revisionRef.current,
      )
      const next = parsePrefs(view.value)
      revisionRef.current = view.revision
      store.setPrefs(next)
      return next
    })
    // A failed commit must not poison the queue: later writes still run.
    inFlightRef.current = run.then(() => undefined, () => undefined)
    return run.then(
      (next) => ({ ok: true, prefs: next }),
      (caught) => {
        setError(messageOf(caught))
        return { ok: false, prefs }
      },
    )
  }

  /** Settle one commit: success adopts the server values, failure reverts. */
  const applyOutcome = (previous: SidebarPrefs, outcome: { ok: boolean; prefs: SidebarPrefs }): void => {
    const settled = outcome.ok ? outcome.prefs : previous
    setPrefs(settled)
    setWidthDraft(String(settled.defaultWidthPercent))
  }

  /** Optimistically apply one pref patch, then commit (revert on failure). */
  const applyPref = (patch: Record<string, unknown>): void => {
    const previous = optimisticRef.current
    const next = { ...previous, ...patch } as SidebarPrefs
    optimisticRef.current = next
    setPrefs(next)
    setError(null)
    void commit(patch).then(outcome => applyOutcome(previous, outcome))
  }

  const onToggle = (next: boolean): void => {
    applyPref({ openByDefault: next })
  }

  /** Flip one per-tab enable switch (merge into the tabsEnabled map). */
  const onToggleTab = (id: string, next: boolean): void => {
    applyPref({ tabsEnabled: { ...optimisticRef.current.tabsEnabled, [id]: next } })
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
    applyPref({ [toggle.key]: next })
  }

  /**
   * Commit one declaratively-declared text/number row. Numbers are parsed
   * and clamped to the toggle's declared min/max (an unparsable input falls
   * back to the CURRENT stored value, mirroring the width row); text rows
   * persist as-is (empty is meaningful, e.g. the theme-default font).
   * Returns the canonical value the row should display.
   */
  const onCommitSetting = (toggle: SidebarSettingToggle, raw: string): string => {
    if (toggle.type === 'number') {
      const parsed = Number(raw)
      const fallback = String((prefs as unknown as Record<string, unknown>)[toggle.key] ?? '')
      if (!Number.isFinite(parsed)) return fallback
      let clamped = Math.round(parsed)
      if (toggle.min !== undefined) clamped = Math.max(toggle.min, clamped)
      if (toggle.max !== undefined) clamped = Math.min(toggle.max, clamped)
      applyPref({ [toggle.key]: clamped })
      return String(clamped)
    }
    applyPref({ [toggle.key]: raw })
    return raw
  }

  /** Persist one plugin-owned setting of one descriptor (merged into the pluginSettings blob). */
  const applyPluginSetting = (descriptorId: string, key: string, value: unknown): void => {
    applyPref({ pluginSettings: mergePluginSetting(optimisticRef.current.pluginSettings, descriptorId, key, value) })
  }

  /** Flip one plugin-owned switch row (same row shape, plugin-scoped key). */
  const onPluginToggle = (descriptorId: string, toggle: SidebarSettingToggle, next: boolean): void => {
    applyPluginSetting(descriptorId, toggle.key, next)
  }

  /** Commit one plugin-owned text/number row (clamped like the host rows). */
  const onPluginCommitSetting = (descriptorId: string, toggle: SidebarSettingToggle, raw: string): string => {
    if (toggle.type === 'number') {
      const parsed = Number(raw)
      const blob = prefs.pluginSettings[descriptorId] ?? {}
      const fallback = String(blob[toggle.key] ?? '')
      if (!Number.isFinite(parsed)) return fallback
      let clamped = Math.round(parsed)
      if (toggle.min !== undefined) clamped = Math.max(toggle.min, clamped)
      if (toggle.max !== undefined) clamped = Math.min(toggle.max, clamped)
      applyPluginSetting(descriptorId, toggle.key, clamped)
      return String(clamped)
    }
    applyPluginSetting(descriptorId, toggle.key, raw)
    return raw
  }

  const commitWidth = (): void => {
    const parsed = Number(widthDraft)
    if (!Number.isFinite(parsed)) {
      setWidthDraft(String(prefs.defaultWidthPercent))
      return
    }
    const clamped = clampWidthPercent(parsed)
    const previous = prefs
    setPrefs({ ...previous, defaultWidthPercent: clamped })
    setWidthDraft(String(clamped))
    setError(null)
    void commit({ defaultWidthPercent: clamped }).then(outcome => applyOutcome(previous, outcome))
  }

  /**
   * One LIST row per user-facing tab type: icon + title + type id left,
   * enable switch + (for features with declared settings) a gear right.
   */
  const renderTabRow = (tab: TabDescriptor): ReactNode => {
    const enabled = prefs.tabsEnabled[tab.id] !== false
    return (
      <div key={tab.id} className={css.row}>
        <span className={css.rowText}>
          <span className={css.titleRow}>
            {iconOf(tab.icon, 14)}
            <span className={css.title}>{textOf(tab.title)}</span>
          </span>
          <span className={css.desc}>{tab.id}</span>
        </span>
        <span className={css.controlRow}>
          {enabled && hasSettings(tab) && (
            <button
              type="button"
              className={css.gear}
              aria-label={`${textOf(tab.title)} ${t('settingsPopup')}`}
              title={t('settingsPopup')}
              onClick={() => { setSettingsFor(tab) }}
            >
              <IconSettingsOutline16 size={14} />
            </button>
          )}
          <Switch
            label={textOf(tab.title)}
            checked={enabled}
            onChange={(next) => { onToggleTab(tab.id, next) }}
          />
        </span>
      </div>
    )
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('settingsIntro')}</p>

      {/* 常规: the DSH settings-row recipe — title/desc left, control right. */}
      <div className={css.group}>
        <div className={css.groupHeading}>{t('settingsGeneralTitle')}</div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsOpenTitle')}</span>
            <span className={css.desc}>{t('settingsOpenDesc')}</span>
          </span>
          <Switch
            label={t('settingsOpenTitle')}
            checked={prefs.openByDefault}
            onChange={onToggle}
          />
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsWidthTitle')}</span>
            <span className={css.desc}>{t('settingsWidthDesc')}</span>
          </span>
          <span className={css.control}>
            <Input
              type="number"
              className={css.percentInput}
              value={widthDraft}
              min={WIDTH_PERCENT_MIN}
              max={WIDTH_PERCENT_MAX}
              step={1}
              aria-label={t('settingsWidthTitle')}
              onChange={event => { setWidthDraft(event.currentTarget.value) }}
              onBlur={commitWidth}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <span className={css.suffix}>{t('settingsWidthSuffix')}</span>
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsOpenPathTitle')}</span>
            <span className={css.desc}>{t('settingsOpenPathDesc')}</span>
          </span>
          <Switch
            label={t('settingsOpenPathTitle')}
            checked={prefs.interceptOpenPath}
            onChange={(next) => { applyPref({ interceptOpenPath: next }) }}
          />
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsAutoSaveCloseTitle')}</span>
            <span className={css.desc}>{t('settingsAutoSaveCloseDesc')}</span>
          </span>
          <Switch
            label={t('settingsAutoSaveCloseTitle')}
            checked={prefs.autoSaveOnClose}
            onChange={(next) => { applyPref({ autoSaveOnClose: next }) }}
          />
        </div>
      </div>

      {/* 侧边栏内容: one list row per registered user-facing tab type;
          features declaring `settings` open their popup through the gear. */}
      <div className={css.group}>
        <div className={css.groupHeading}>
          <span>{t('settingsTabsTitle')}</span>
          <span className={css.count}>{tabs.length}</span>
        </div>
        {tabs.map(tab => (
          <Fragment key={tab.id}>
            {renderTabRow(tab)}
          </Fragment>
        ))}
      </div>

      {/* The secondary settings popup: a feature's declared related settings
          as title/desc + switch rows in a wider-than-default Modal with a
          Done footer (Modal chrome is the app's own). Mounted only while a
          feature is open — the Modal primitive runs hooks unconditionally,
          so a closed-but-mounted Modal would break SSR (and the
          renderToString spec) under the test dual-react split.
          Content: `settings.render` (custom panel) when declared, else the
          host-prefs `toggles` rows followed by the plugin-owned
          `pluginToggles` rows (their values live in pluginSettings[id]). */}
      {settingsFor !== null && (
        <Modal
          open
          onClose={() => { setSettingsFor(null) }}
          title={featureNameOf(settingsFor)}
          description={t('settingsPopupDesc', { feature: featureNameOf(settingsFor) })}
          closeLabel={t('close')}
          className={css.popupDialog}
          footer={(
            <button type="button" className={css.done} onClick={() => { setSettingsFor(null) }}>
              {t('settingsDone')}
            </button>
          )}
        >
          <SettingsBody
            feature={settingsFor}
            prefs={prefs}
            onToggle={onToggleSetting}
            onCommit={onCommitSetting}
            onPluginToggle={(toggle, next) => { onPluginToggle(settingsFor.id, toggle, next) }}
            onPluginCommit={(toggle, raw) => onPluginCommitSetting(settingsFor.id, toggle, raw)}
            onPluginWrite={(key, value) => { applyPluginSetting(settingsFor.id, key, value) }}
            onClose={() => { setSettingsFor(null) }}
            store={store}
            service={service}
          />
        </Modal>
      )}

      {error !== null && (
        <div className={css.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
