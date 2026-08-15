/**
 * Side card settings section render tests: the section is DECLARATIVE —
 * every small card (icon, title, type id, extensions, on/off state) derives
 * from the sidebar service's tab/viewer registries instead of hardcoded
 * copy. The toggles are CARDS in a responsive grid: the card's main area is
 * the switch, the visual state IS the state (highlighted = enabled),
 * announced via `aria-pressed`, and the check badge sits at the far right.
 * The general rows follow the DSH settings-row recipe with custom SWITCHES
 * (real checkboxes driving a styled track). Features that declare related
 * settings carry a gear corner button whose popup rows (switch controls)
 * are tested through the extracted FeatureSettingsRows component (the Modal
 * portal renders only while open).
 *
 * Rendered with renderToString (mount effects — the settings RPC sync — do
 * not run in SSR; the initial store prefs are the render input).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createVscodeSidebarService, type VscodeSidebarService } from '../src/client/service.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { attachLocale } from '../src/client/locales.ts'
import { FeatureSettingsRows, mergePluginSetting, SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'

/**
 * The copy assertions below are written against the English dictionary, so
 * the locale service is pinned to en-US for the duration of the spec — the
 * test host's browser/OS language (e.g. zh-CN on a Chinese Windows) must not
 * leak into the rendered copy.
 */
beforeEach(() => {
  attachLocale({ getSnapshot: () => ({ active: 'en-US' }) })
})

afterEach(() => {
  attachLocale(undefined)
})

/** One tab + one viewer + the subagent-style nested toggle under a tab. */
function mount(): { store: SidebarStore; service: VscodeSidebarService } {
  const store = createSidebarStore()
  const service = createVscodeSidebarService(store)
  service.registerTab({
    id: 'explorer',
    title: () => 'Explorer',
    icon: () => createElement('svg', { 'data-icon': 'explorer' }),
    order: 10,
    component: () => null,
  })
  service.registerTab({
    id: 'subagent',
    title: () => 'Subagents',
    icon: () => createElement('svg', { 'data-icon': 'subagent' }),
    order: 30,
    settings: {
      toggles: [{
        key: 'autoOpenSubagent',
        title: () => 'Auto-open Subagents',
        desc: () => 'Expand on new subagent',
      }],
    },
    component: () => null,
  })
  service.registerFileViewer({
    id: 'image',
    title: () => 'Image',
    icon: () => createElement('svg', { 'data-icon': 'image' }),
    exts: ['png', 'jpg'],
    fetchStrategy: 'mediaUrl',
    component: () => null,
  })
  return { store, service }
}

function renderSection(store: SidebarStore, service: VscodeSidebarService): string {
  return renderToString(createElement(
    SideCardSection,
    { store, service } as unknown as SideCardSectionProps,
  ))
}

describe('SideCardSection declarative inventory', () => {
  it('renders one LIST row per registered user-facing tab: icon + title + type id + switch', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('data-icon="explorer"')
    expect(html).toContain('>Explorer<')
    // The type id is the row's desc (the declarative "type" surface).
    expect(html).toContain('>explorer<')
    expect(html).toContain('data-icon="subagent"')
    expect(html).toContain('>Subagents<')
    // Rows are real checkbox switches (aria-label = the title), checked by
    // default: the two tabs. The nested auto-open toggle is NOT an inline
    // row (it lives in the popup).
    expect(html.match(/aria-label="Explorer"/g)?.length).toBe(1)
    expect(html.match(/aria-label="Subagents"/g)?.length).toBe(1)
    expect(html.match(/checked=""/g)?.length).toBe(4) // 2 general + 2 tabs
    expect(html).not.toContain('Auto-open Subagents')
  })

  it('renders the section intro and the tab group heading with the inventory count', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('Manage what the side card shows and how it behaves')
    // The tab group carries the count badge (2 user-facing tabs).
    expect(html).toContain('>Sidebar content</span><span')
    expect(html).toContain('>2</span>')
    // The viewer inventory is gone.
    expect(html).not.toContain('File viewers')
  })

  it('does not list registered viewers or hidden tabs', () => {
    const { store, service } = mount()
    // A hidden internal page (editor-like) must never appear in the inventory.
    service.registerTab({
      id: 'editor',
      title: () => 'Editor',
      hidden: true,
      order: -1,
      component: () => null,
    })
    const html = renderSection(store, service)
    expect(html).not.toContain('data-icon="image"')
    expect(html).not.toContain('>Image<')
    expect(html).not.toContain('png · jpg')
    expect(html).not.toContain('>Editor<')
    expect(html).not.toContain('>editor<')
  })

  it('renders the gear on rows that declare related settings', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    // Subagents declares a toggle → its row carries the settings gear
    // (aria-label = "<title> Feature settings"); Explorer declares none.
    expect(html.match(/aria-label="[^"]*Feature settings"/g)?.length).toBe(1)
  })

  it('offers no add-plugin cards', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).not.toContain('Add tab plugins')
    expect(html).not.toContain('Add preview plugins')
  })

  it('a disabled feature renders an unchecked switch', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    expect(html).toContain('>Subagents<')
    // The subagent switch is now unchecked; the general switches stay checked.
    expect(html.match(/checked=""/g)?.length).toBe(3) // 2 general + explorer
  })

  it('hides the gear of a disabled feature (its related settings are dormant)', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    expect(html).not.toContain('Feature settings')
  })
})

describe('FeatureSettingsRows (the secondary settings popup body)', () => {
  const prefs: typeof SIDEBAR_PREFS_DEFAULTS = {
    ...SIDEBAR_PREFS_DEFAULTS,
    autoOpenSubagent: false,
  }
  const toggles = [{
    key: 'autoOpenSubagent',
    title: () => 'Auto-open Subagents',
    desc: () => 'Expand on new subagent',
  }]

  it('renders one switch row per declared toggle with its current value', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles,
      prefs,
      onToggle: () => {},
    }))
    expect(html).toContain('Auto-open Subagents')
    expect(html).toContain('Expand on new subagent')
    // The row's switch is a real checkbox (aria-label = the toggle title)
    // reflecting the prefs value (false here → unchecked).
    expect(html).toContain('aria-label="Auto-open Subagents"')
    expect(html).not.toContain('checked=""')
  })

  it('checks the row when the pref is on', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles,
      prefs: { ...prefs, autoOpenSubagent: true },
      onToggle: () => {},
    }))
    expect(html).toContain('checked=""')
  })

  it('renders a text row as an input seeded with the pref value (empty = theme default)', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'terminalFontFamily',
        type: 'text',
        title: () => 'Font family',
        desc: () => 'CSS stack',
        placeholder: '"JetBrains Mono", monospace',
      }],
      prefs: { ...prefs, terminalFontFamily: '"JetBrains Mono", monospace' },
      onToggle: () => {},
      onCommit: () => '',
    }))
    expect(html).toContain('Font family')
    expect(html).toContain('placeholder="&quot;JetBrains Mono&quot;, monospace"')
    // The input carries the pref value (no switch for text rows).
    expect(html).toContain('value="&quot;JetBrains Mono&quot;, monospace"')
    expect(html).not.toContain('type="checkbox"')
  })

  it('renders a number row with the pref value, the declared bounds and a unit suffix', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'terminalFontSize',
        type: 'number',
        title: () => 'Font size',
        min: 9,
        max: 32,
        unit: 'px',
      }],
      prefs: { ...prefs, terminalFontSize: 18 },
      onToggle: () => {},
      onCommit: () => '18',
    }))
    expect(html).toContain('Font size')
    expect(html).toContain('type="number"')
    expect(html).toContain('value="18"')
    expect(html).toContain('min="9"')
    expect(html).toContain('max="32"')
    expect(html).toContain('px')
    expect(html).not.toContain('type="checkbox"')
  })
})

describe('mergePluginSetting (v0.12.0, codex review fix)', () => {
  it('sequential merges are additive — a later write never drops an earlier key', () => {
    // Simulates two same-tick updatePluginSetting calls: each merge spreads
    // the map it was GIVEN, so building from the latest optimistic map
    // preserves both keys (the pre-fix code spread the stale render-time
    // prefs twice and the second write dropped the first key).
    let map: Record<string, Record<string, unknown>> = {}
    map = mergePluginSetting(map, 'my-plugin:db', 'pageSize', 25)
    map = mergePluginSetting(map, 'my-plugin:db', 'theme', 'dark')
    expect(map['my-plugin:db']).toEqual({ pageSize: 25, theme: 'dark' })
    // A second descriptor's blob stays independent.
    map = mergePluginSetting(map, 'other:view', 'refresh', true)
    expect(map['my-plugin:db']).toEqual({ pageSize: 25, theme: 'dark' })
    expect(map['other:view']).toEqual({ refresh: true })
    // Overwriting one key keeps the sibling keys.
    map = mergePluginSetting(map, 'my-plugin:db', 'pageSize', 50)
    expect(map['my-plugin:db']).toEqual({ pageSize: 50, theme: 'dark' })
  })
})

describe('FeatureSettingsRows valueSource (v0.12.0, independent CR fix)', () => {
  it('plugin rows read from their OWN value source — a plugin key colliding with a host pref never reads the host value', () => {
    const prefs = { ...SIDEBAR_PREFS_DEFAULTS, openByDefault: true }
    const toggle = { key: 'openByDefault', title: 'My flag' }
    // valueOf returns undefined (the plugin never wrote this key): the row
    // must render UNCHECKED even though the host pref openByDefault is true.
    let html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      valueSource: () => undefined,
    }))
    expect(html).not.toContain('checked=""')
    // The plugin wrote `true` into its own blob: the row is checked.
    html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      valueSource: () => true,
    }))
    expect(html).toContain('checked=""')
    // Without valueOf the row falls back to the prefs face (host semantics).
    html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
    }))
    expect(html).toContain('checked=""')
  })
})
