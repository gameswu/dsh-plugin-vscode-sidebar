/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu with copy/download plus the file operations — create
 * a file or folder inside a directory (the header + button does the same at
 * the root), rename (inline name editing), and delete (with a confirm
 * modal). The affected directory refetches after every successful operation.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCopyOutline16, IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline16, Menu, Modal,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { FileTypeIcon, FolderTypeIcon, RootFolderIcon } from './file-icons.tsx'
import { gitStatusBadgeClass, gitStatusLetter, gitStatusNameClass } from './git-status.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** Parent directory of a path, PRESERVING the path's own separator style —
 *  the value is used as a directory-cache key, so normalizing separators
 *  here would make the key miss and silently skip the post-op refresh
 *  (the #ops-no-refresh regression). A drive root keeps its slash. */
function parentPath(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (at <= 0) return path
  const parent = path.slice(0, at)
  return parent.length === 2 && parent[1] === ':' ? `${parent}/` : parent
}

/** Whether `child` equals `dir` or lies inside it (mixed-separator tolerant). */
function isInside(dir: string, child: string): boolean {
  const base = dir.replace(/\\/g, '/').replace(/\/$/, '')
  const target = child.replace(/\\/g, '/')
  return target === base || target.startsWith(`${base}/`)
}

/** Drag payload for moving an entry onto a directory row (HTML5 DnD). */
const EXPLORER_DRAG_TYPE = 'application/x-dsh-explorer-path'

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** How often the visible explorer refetches its loaded levels (no watcher). */
const REFRESH_INTERVAL_MS = 5000

/**
 * The inline name-input row (create / rename): Enter commits, Escape
 * cancels. Blur commits ONLY a non-empty name — an empty blur (a focus
 * steal from a just-closed menu, or clicking away before typing) keeps the
 * row alive so the input can never vanish without the user seeing it. The
 * commit handlers are pending-state-guarded, so the unmount after a commit
 * can never fire a second write.
 *
 * `embedded` renders the bare input for the RENAME case (it replaces the
 * name INSIDE an existing row — no nested full-width row); standalone rows
 * (create) wrap it in a tree row of their own.
 */
function NameInputRow(props: {
  initial: string
  depth: number
  embedded?: boolean
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const { initial, depth, embedded, onCommit, onCancel } = props
  const input = (
    <input
      className={css.explorerNameInput}
      defaultValue={initial}
      autoFocus
      spellCheck={false}
      aria-label={t('entryName')}
      onClick={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit((event.target as HTMLInputElement).value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={(event) => {
        const value = (event.target as HTMLInputElement).value
        if (value.trim() !== '') onCommit(value)
      }}
    />
  )
  if (embedded === true) return input
  return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{input}</div>
}

export function ExplorerView(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
  /** Whether the page is actually visible (pauses auto-refresh otherwise). */
  visible: boolean
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onReferenceFile, visible } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [refreshTick, setRefreshTick] = useState(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  /** Inline creation: the parent directory + kind (renders a name-input row there). */
  const [createAt, setCreateAt] = useState<{ parent: string; isDir: boolean } | null>(null)
  /** Inline rename: the entry path + current draft name. */
  const [renameAt, setRenameAt] = useState<{ path: string; name: string } | null>(null)
  /** Pending delete confirmation. */
  const [deleteAt, setDeleteAt] = useState<{ path: string; name: string; isDir: boolean } | null>(null)
  /** The header + menu (create at the session root). */
  const [plusOpen, setPlusOpen] = useState(false)
  /** The last failed file operation's message (dismissible banner row). */
  const [opError, setOpError] = useState<string | null>(null)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  /** Drop one level's cache so the next refresh refetches it (file ops). */
  const refreshDir = useCallback((dir: string) => {
    const next = { ...dataRef.current }
    delete next[dir]
    dataRef.current = next
    setData(next)
    setRefreshTick(tick => tick + 1)
  }, [])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh button wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  // Auto-refresh: while the page is visible the loaded levels refetch on a
  // fixed cadence and on window focus (files change outside the sidebar too
  // — the agent writes them). Invisible pages skip the polling entirely.
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => { setRefreshTick(tick => tick + 1) }, REFRESH_INTERVAL_MS)
    const onFocus = (): void => { setRefreshTick(tick => tick + 1) }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [visible])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <button
        type="button"
        className={css.explorerRef}
        aria-label={t('referenceFile')}
        title={t('referenceFile')}
        onClick={(event) => {
          event.stopPropagation()
          onReferenceFile(entry.path)
        }}
      >
        {t('referenceFile')}
      </button>
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }

  // ── File operations (create / rename / delete) ───────────────────────────

  /** The wire message of a failed file operation. */
  const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  const commitCreate = useCallback((name: string): void => {
    const pending = createAt
    if (pending === null) return
    setCreateAt(null)
    const trimmed = name.trim()
    if (trimmed === '') return
    api.fsCreate({ sessionId, cwd }, pending.parent, trimmed, pending.isDir).then(() => {
      setOpError(null)
      refreshDir(pending.parent)
    }).catch((error: unknown) => { setOpError(errorMessage(error)) })
  }, [createAt, sessionId, cwd, refreshDir])

  const commitRename = useCallback((name: string): void => {
    const pending = renameAt
    if (pending === null) return
    setRenameAt(null)
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === pending.name) return
    api.fsRename({ sessionId, cwd }, pending.path, trimmed).then(() => {
      setOpError(null)
      // The parent listing refetches with the new name; an expanded renamed
      // directory keeps its old expansion slot (harmless: the shell's
      // expanded set is refreshed by the parent refetch + user toggles).
      refreshDir(parentPath(pending.path))
    }).catch((error: unknown) => { setOpError(errorMessage(error)) })
  }, [renameAt, sessionId, cwd, refreshDir])

  const performDelete = useCallback((): void => {
    const pending = deleteAt
    if (pending === null) return
    setDeleteAt(null)
    api.fsDelete({ sessionId, cwd }, pending.path).then(() => {
      setOpError(null)
      refreshDir(parentPath(pending.path))
    }).catch((error: unknown) => { setOpError(errorMessage(error)) })
  }, [deleteAt, sessionId, cwd, refreshDir])

  /** Start creating an entry inside `parent` (the input row replaces the listing). */
  const startCreate = useCallback((parent: string, isDir: boolean): void => {
    setRenameAt(null)
    setOpError(null)
    setCreateAt({ parent, isDir })
  }, [])

  /** Start renaming one entry inline. */
  const startRename = useCallback((path: string, name: string): void => {
    setCreateAt(null)
    setOpError(null)
    setRenameAt({ path, name })
  }, [])

  // ── Drag & drop (VSCode-style move onto a directory row) ─────────────────

  /** The entry currently being dragged (null = no explorer drag in flight). */
  const [dragEntry, setDragEntry] = useState<{ path: string; isDir: boolean } | null>(null)
  /** The directory row the dragged entry currently hovers (drop highlight). */
  const [dropDir, setDropDir] = useState<string | null>(null)

  /** Whether `target` is a legal drop directory for the dragged entry. */
  const canDrop = useCallback((target: string): boolean => {
    if (dragEntry === null) return false
    if (target === dragEntry.path || target === parentPath(dragEntry.path)) return false
    if (dragEntry.isDir && isInside(dragEntry.path, target)) return false
    return true
  }, [dragEntry])

  /** Move the dragged entry into `toDir` (the host keeps its name). */
  const moveEntry = useCallback((source: string, toDir: string): void => {
    api.fsMove({ sessionId, cwd }, source, toDir).then(() => {
      setOpError(null)
      refreshDir(parentPath(source))
      refreshDir(toDir)
    }).catch((error: unknown) => { setOpError(errorMessage(error)) })
  }, [sessionId, cwd, refreshDir])

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const root = cwd

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    const creatingHere = createAt !== null && createAt.parent === dir
    const createRow = creatingHere ? (
      <NameInputRow
        key="__create__"
        initial=""
        depth={depth}
        onCommit={commitCreate}
        onCancel={() => { setCreateAt(null) }}
      />
    ) : null
    return (
      <>
        {createRow}
        {entries.map(entry => {
          /** The SCM-linked status letter (colored like the git panel). */
          const gitBadge: ReactNode = entry.git === undefined ? null : (
            <span className={clsx(css.explorerGitBadge, gitStatusBadgeClass(entry.git))}>
              {gitStatusLetter(entry.git)}
            </span>
          )
          const nameClass = clsx(css.explorerName, entry.git !== undefined && gitStatusNameClass(entry.git))
          const renaming = renameAt !== null && renameAt.path === entry.path
          /** DnD row handlers shared by every DIRECTORY row (the drop target). */
          const dropHandlers = {
            onDragOver: (event: DragEvent<HTMLDivElement>): void => {
              if (!canDrop(entry.path)) return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              if (dropDir !== entry.path) setDropDir(entry.path)
            },
            onDragLeave: (event: DragEvent<HTMLDivElement>): void => {
              const related = event.relatedTarget as Node | null
              if (related === null || !event.currentTarget.contains(related)) {
                setDropDir(current => current === entry.path ? null : current)
              }
            },
            onDrop: (event: DragEvent<HTMLDivElement>): void => {
              event.preventDefault()
              event.stopPropagation()
              setDropDir(null)
              const source = event.dataTransfer.getData(EXPLORER_DRAG_TYPE) || dragEntry?.path
              if (source === undefined || source === '' || !canDrop(entry.path)) return
              moveEntry(source, entry.path)
              setDragEntry(null)
            },
          }
          if (entry.isDir) {
            const isOpen = expanded.includes(entry.path)
            return (
              <div key={entry.path}>
                <div
                  role="button"
                  tabIndex={0}
                  draggable={!renaming}
                  className={clsx(
                    css.explorerRow,
                    css.explorerDir,
                    entry.hidden && css.explorerHidden,
                    dropDir === entry.path && css.explorerRowDrop,
                  )}
                  style={{ paddingLeft: depth * 22 + 6 }}
                  onClick={() => { onToggle(entry.path) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onToggle(entry.path)
                    }
                  }}
                  onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
                  onDragStart={(event) => {
                    event.stopPropagation()
                    event.dataTransfer.setData(EXPLORER_DRAG_TYPE, entry.path)
                    event.dataTransfer.effectAllowed = 'move'
                    setDragEntry({ path: entry.path, isDir: true })
                  }}
                  onDragEnd={() => { setDragEntry(null); setDropDir(null) }}
                  {...dropHandlers}
                >
                  <FolderTypeIcon name={entry.name} open={isOpen} size={14} />
                  {renaming
                    ? (
                      <NameInputRow
                        initial={entry.name}
                        depth={0}
                        embedded
                        onCommit={commitRename}
                        onCancel={() => { setRenameAt(null) }}
                      />
                    )
                    : (
                      <>
                        <span className={nameClass}>{entry.name}</span>
                        {rowActions(entry)}
                        {gitBadge}
                      </>
                    )}
                </div>
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            )
          }
          return (
            <div
              key={entry.path}
              role="button"
              tabIndex={0}
              draggable={!renaming}
              className={clsx(css.explorerRow, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              title={entry.path}
              onClick={() => { onOpenFile(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenFile(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
              onDragStart={(event) => {
                event.stopPropagation()
                event.dataTransfer.setData(EXPLORER_DRAG_TYPE, entry.path)
                event.dataTransfer.effectAllowed = 'move'
                setDragEntry({ path: entry.path, isDir: false })
              }}
              onDragEnd={() => { setDragEntry(null); setDropDir(null) }}
            >
              <FileTypeIcon name={entry.name} size={14} />
              {renaming
                ? (
                  <NameInputRow
                    initial={entry.name}
                    depth={0}
                    embedded
                    onCommit={commitRename}
                    onCancel={() => { setRenameAt(null) }}
                  />
                )
                : (
                  <>
                    <span className={nameClass}>{entry.name}</span>
                    {rowActions(entry)}
                    {gitBadge}
                  </>
                )}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div className={css.explorer}>
      <div className={css.explorerHeader}>
        <span className={css.explorerRoot} title={root}>{root === undefined ? t('noSession') : baseName(root)}</span>
        <div className={css.explorerHeaderActions}>
          {root !== undefined && (
            <Menu
              open={plusOpen}
              onClose={() => { setPlusOpen(false) }}
              items={[
                { id: 'file', label: t('newFile') },
                { id: 'dir', label: t('newFolder') },
              ]}
              onSelect={(id) => {
                setPlusOpen(false)
                if (root !== undefined) startCreate(root, id === 'dir')
              }}
              portal
              align="end"
              anchor={(
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('newFile')}
                  title={t('newFile')}
                  onClick={() => { setPlusOpen(open => !open) }}
                >
                  <IconPlusOutline16 />
                </button>
              )}
            />
          )}
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={() => {
              dataRef.current = {}
              setData({})
              setRefreshTick(tick => tick + 1)
            }}
          >
            <IconRefreshOutline16 />
          </button>
        </div>
      </div>
      {opError !== null && (
        <div
          className={css.explorerOpError}
          role="alert"
          title={t('close')}
          onClick={() => { setOpError(null) }}
        >
          {opError}
        </div>
      )}
      <div
        className={css.explorerBody}
        // Right-clicking ANYWHERE inside the explorer tab (empty space below
        // the tree included) opens the shared context menu for the session
        // root — rows open their own menu and stop propagation, so this only
        // fires on unclaimed areas.
        onContextMenu={(event) => {
          if (root === undefined) return
          openRowMenu(event, root, true)
        }}
      >
        {root === undefined ? (
          <div className={css.explorerEmpty}>{t('noSession')}</div>
        ) : (
          <>
            <div
              className={clsx(css.explorerRow, dropDir === root && css.explorerRowDrop)}
              style={{ paddingLeft: 6 }}
              onContextMenu={(event) => { openRowMenu(event, root, true) }}
              onDragOver={(event) => {
                if (!canDrop(root)) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                if (dropDir !== root) setDropDir(root)
              }}
              onDragLeave={(event) => {
                const related = event.relatedTarget as Node | null
                if (related === null || !event.currentTarget.contains(related)) {
                  setDropDir(current => current === root ? null : current)
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropDir(null)
                const source = event.dataTransfer.getData(EXPLORER_DRAG_TYPE) || dragEntry?.path
                if (source === undefined || source === '' || !canDrop(root)) return
                moveEntry(source, root)
                setDragEntry(null)
              }}
            >
              <RootFolderIcon name={baseName(root)} open size={14} />
              <span className={css.explorerName}>{baseName(root)}</span>
              {copiedPath === root
                ? <span className={css.explorerCopied}>{t('copied')}</span>
                : (
                  <button
                    type="button"
                    className={css.explorerRef}
                    aria-label={t('referenceFile')}
                    title={t('referenceFile')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onReferenceFile(root)
                    }}
                  >
                    {t('referenceFile')}
                  </button>
                )}
            </div>
            {data[root] !== undefined && renderLevel(root, 1)}
          </>
        )}
      </div>
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the explorer's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // Create inside this directory (files too — their parent is the row itself
          // only for dirs; for files the creation lands in the SAME directory).
          { id: 'create-file', label: t('newFile') },
          { id: 'create-dir', label: t('newFolder') },
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          // Rename/delete everything except the session root (the host refuses).
          ...(rowMenu !== null && rowMenu.path !== (cwd ?? '') ? [
            { id: 'rename', label: t('rename') },
            { id: 'delete', label: t('deleteEntry') },
          ] : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'create-file') {
            startCreate(target.isDir ? target.path : parentPath(target.path), false)
            return
          }
          if (id === 'create-dir') {
            startCreate(target.isDir ? target.path : parentPath(target.path), true)
            return
          }
          if (id === 'rename') {
            startRename(target.path, baseName(target.path))
            return
          }
          if (id === 'delete') {
            setDeleteAt({ path: target.path, name: baseName(target.path), isDir: target.isDir })
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
      <Modal
        open={deleteAt !== null}
        onClose={() => { setDeleteAt(null) }}
        title={t('deleteEntry')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDeleteAt(null) }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={performDelete}>
              {t('deleteEntry')}
            </Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>{t('deleteEntryDesc', { name: deleteAt?.name ?? '' })}</p>
      </Modal>
    </div>
  )
}
