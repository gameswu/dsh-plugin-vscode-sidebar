/**
 * Serializable configuration and defaults for the sidebar host half. Loader
 * schema validation normally fills defaults; {@link resolveSidebarConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 * @module dsh-plugin-vscode-sidebar/config
 */

import z from 'schemastery'
import {
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  WIDTH_PERCENT_DEFAULT,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

export {
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  WIDTH_PERCENT_DEFAULT,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

/** Tunable sidebar host limits (every field optional; defaults fill in). */
export interface SidebarConfig {
  /** Read cap of one text file (bytes); larger files return truncated. */
  readLimit?: number
  /** Media route cap (bytes); larger binaries are refused. */
  mediaLimit?: number
  /** Explorer row bound of one level. */
  listLimit?: number
  /** Terminals per session. */
  terminalsPerSession?: number
  /** How long a disconnected terminal process survives awaiting a reconnect. */
  reconnectGraceMs?: number
  // ── User-facing preferences (merged into the OFFICIAL plugin-config page;
  //    applied as the base of the live settings namespace) ──────────────────
  /** Whether a brand-new conversation opens the side card by default. */
  openByDefault?: boolean
  /** Default panel width as a percent of the window width (20–60). */
  defaultWidthPercent?: number
  /** Auto-expand the Tasks page when a new subagent appears. */
  autoOpenSubagent?: boolean
  /** Auto-expand the Jobs page when a new background job appears. */
  autoOpenJobs?: boolean
  /** Auto-expand the streaming output of a new background job / agent terminal. */
  autoOpenJobStream?: boolean
  /** Auto-save editor tabs with unsaved changes on close (no confirm). */
  autoSaveOnClose?: boolean
  /** Inject the model-facing terminal tools (off by default). */
  agentTerminalTools?: boolean
  /** Auto-open a terminal on the bottom panel's first expansion. */
  bottomPanelAutoTerminal?: boolean
  /** Custom terminal font-family stack ('' follows the theme). */
  terminalFontFamily?: string
  /** Terminal font size in px (9–32). */
  terminalFontSize?: number
  /** Open chat-side file links in the sidebar editor. */
  interceptOpenPath?: boolean
  /** Drop the HTML preview sandbox (unsafe). */
  htmlViewerNoSandbox?: boolean
  /** Start HTML previews unsandboxed (unsafe). */
  htmlViewerDefaultUnsafe?: boolean
  /** Drop the browser tab sandbox (unsafe). */
  browserNoSandbox?: boolean
  /** Open chat external links in the sidebar browser. */
  browserInterceptLinks?: boolean
}

/** Schemastery schema for the plugin configuration. */
export const Config: z<SidebarConfig> = z.object({
  readLimit: z.number().step(1).min(1).default(512 * 1024),
  mediaLimit: z.number().step(1).min(1).default(20 * 1024 * 1024),
  listLimit: z.number().step(1).min(1).default(1000),
  terminalsPerSession: z.number().step(1).min(1).default(3),
  reconnectGraceMs: z.number().step(1).min(0).default(30_000),
  openByDefault: z.boolean().default(true),
  defaultWidthPercent: z.number().step(1).min(WIDTH_PERCENT_MIN).max(WIDTH_PERCENT_MAX).default(WIDTH_PERCENT_DEFAULT),
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  autoOpenJobStream: z.boolean().default(true),
  autoSaveOnClose: z.boolean().default(false),
  agentTerminalTools: z.boolean().default(false),
  bottomPanelAutoTerminal: z.boolean().default(true),
  terminalFontFamily: z.string().default(''),
  terminalFontSize: z.number().step(1).min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).default(TERMINAL_FONT_SIZE_DEFAULT),
  interceptOpenPath: z.boolean().default(true),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  browserNoSandbox: z.boolean().default(false),
  browserInterceptLinks: z.boolean().default(true),
})

/** Fully defaulted sidebar host settings (including the user-prefs base). */
export interface ResolvedSidebarConfig {
  readLimit: number
  mediaLimit: number
  listLimit: number
  terminalsPerSession: number
  reconnectGraceMs: number
  openByDefault: boolean
  defaultWidthPercent: number
  autoOpenSubagent: boolean
  autoOpenJobs: boolean
  autoOpenJobStream: boolean
  autoSaveOnClose: boolean
  agentTerminalTools: boolean
  bottomPanelAutoTerminal: boolean
  terminalFontFamily: string
  terminalFontSize: number
  interceptOpenPath: boolean
  htmlViewerNoSandbox: boolean
  htmlViewerDefaultUnsafe: boolean
  browserNoSandbox: boolean
  browserInterceptLinks: boolean
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided sidebar host settings.
 * @returns Complete settings consumed by the host half.
 */
export function resolveSidebarConfig(config: SidebarConfig | undefined): ResolvedSidebarConfig {
  return {
    readLimit: config?.readLimit ?? 512 * 1024,
    mediaLimit: config?.mediaLimit ?? 20 * 1024 * 1024,
    listLimit: config?.listLimit ?? 1000,
    terminalsPerSession: config?.terminalsPerSession ?? 3,
    reconnectGraceMs: config?.reconnectGraceMs ?? 30_000,
    openByDefault: config?.openByDefault ?? SIDEBAR_PREFS_DEFAULTS.openByDefault,
    defaultWidthPercent: config?.defaultWidthPercent ?? SIDEBAR_PREFS_DEFAULTS.defaultWidthPercent,
    autoOpenSubagent: config?.autoOpenSubagent ?? SIDEBAR_PREFS_DEFAULTS.autoOpenSubagent,
    autoOpenJobs: config?.autoOpenJobs ?? SIDEBAR_PREFS_DEFAULTS.autoOpenJobs,
    autoOpenJobStream: config?.autoOpenJobStream ?? SIDEBAR_PREFS_DEFAULTS.autoOpenJobStream,
    autoSaveOnClose: config?.autoSaveOnClose ?? SIDEBAR_PREFS_DEFAULTS.autoSaveOnClose,
    agentTerminalTools: config?.agentTerminalTools ?? SIDEBAR_PREFS_DEFAULTS.agentTerminalTools,
    bottomPanelAutoTerminal: config?.bottomPanelAutoTerminal ?? SIDEBAR_PREFS_DEFAULTS.bottomPanelAutoTerminal,
    terminalFontFamily: config?.terminalFontFamily ?? SIDEBAR_PREFS_DEFAULTS.terminalFontFamily,
    terminalFontSize: config?.terminalFontSize ?? SIDEBAR_PREFS_DEFAULTS.terminalFontSize,
    interceptOpenPath: config?.interceptOpenPath ?? SIDEBAR_PREFS_DEFAULTS.interceptOpenPath,
    htmlViewerNoSandbox: config?.htmlViewerNoSandbox ?? SIDEBAR_PREFS_DEFAULTS.htmlViewerNoSandbox,
    htmlViewerDefaultUnsafe: config?.htmlViewerDefaultUnsafe ?? SIDEBAR_PREFS_DEFAULTS.htmlViewerDefaultUnsafe,
    browserNoSandbox: config?.browserNoSandbox ?? SIDEBAR_PREFS_DEFAULTS.browserNoSandbox,
    browserInterceptLinks: config?.browserInterceptLinks ?? SIDEBAR_PREFS_DEFAULTS.browserInterceptLinks,
  }
}

/** The user-preference slice of the resolved config (the settings-namespace base). */
export function prefsBaseOf(resolved: ResolvedSidebarConfig): SidebarPrefs {
  return {
    openByDefault: resolved.openByDefault,
    defaultWidthPercent: resolved.defaultWidthPercent,
    autoOpenSubagent: resolved.autoOpenSubagent,
    autoOpenJobs: resolved.autoOpenJobs,
    autoOpenJobStream: resolved.autoOpenJobStream,
    autoSaveOnClose: resolved.autoSaveOnClose,
    agentTerminalTools: resolved.agentTerminalTools,
    bottomPanelAutoTerminal: resolved.bottomPanelAutoTerminal,
    terminalFontFamily: resolved.terminalFontFamily,
    terminalFontSize: resolved.terminalFontSize,
    interceptOpenPath: resolved.interceptOpenPath,
    htmlViewerNoSandbox: resolved.htmlViewerNoSandbox,
    htmlViewerDefaultUnsafe: resolved.htmlViewerDefaultUnsafe,
    browserNoSandbox: resolved.browserNoSandbox,
    browserInterceptLinks: resolved.browserInterceptLinks,
    tabsEnabled: {},
    viewersEnabled: {},
    pluginSettings: {},
  }
}

// ── User-facing "Side card" preferences ─────────────────────────────────────

/** Schemastery schema for the user-facing preferences (validated by the settings service). */
export const PrefsSchema: z<SidebarPrefs> = z.object({
  openByDefault: z.boolean().default(true),
  defaultWidthPercent: z.number().step(1).min(WIDTH_PERCENT_MIN).max(WIDTH_PERCENT_MAX).default(WIDTH_PERCENT_DEFAULT),
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  autoOpenJobStream: z.boolean().default(true),
  autoSaveOnClose: z.boolean().default(false),
  agentTerminalTools: z.boolean().default(false),
  bottomPanelAutoTerminal: z.boolean().default(true),
  terminalFontFamily: z.string().default(''),
  terminalFontSize: z.number().step(1).min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).default(TERMINAL_FONT_SIZE_DEFAULT),
  interceptOpenPath: z.boolean().default(true),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  browserNoSandbox: z.boolean().default(false),
  browserInterceptLinks: z.boolean().default(true),
  // Per-feature enable switches are OPEN maps (any tab/viewer id, built-in or
  // external): an absent key means enabled, so old documents resolve to {}
  // (everything on) with no migration. Non-boolean values fail validation.
  tabsEnabled: z.dict(z.boolean()).default({}),
  viewersEnabled: z.dict(z.boolean()).default({}),
  // Plugin-owned settings blobs (v0.12.0+) are an OPEN nested map: any
  // descriptor id may carry any JSON-serializable values. This is the
  // "settings seam" opening — without it the seam would drop third-party
  // keys as unknown schema fields.
  pluginSettings: z.dict(z.dict(z.any())).default({}),
})
