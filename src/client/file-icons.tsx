/**
 * vscode-icons integration for the file explorer: the mapping library
 * (vscode-icons-js) resolves a file/folder NAME to the vscode-icons SVG
 * file name (`file_type_typescript.svg`); the host serves those SVGs from
 * the plugin's own fenced /sidebar/icons route (see bundle-route.ts). The
 * components render an <img> and fall back to the app's outline glyphs when
 * the icon is missing or the route is unreachable, so the explorer never
 * loses its rows to a broken icon.
 */
import { useState, type ReactNode } from 'react'
import {
  IconCodeOutline16, IconFolderClose16, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  getIconForFile, getIconForFolder, getIconForOpenFolder,
  DEFAULT_FILE, DEFAULT_FOLDER, DEFAULT_FOLDER_OPENED, DEFAULT_ROOT, DEFAULT_ROOT_OPENED,
} from 'vscode-icons-js'
import css from './sidebar.module.css'

/** Absolute URL of one vscode-icons SVG served by the host route. */
export function iconUrl(name: string): string {
  return `/sidebar/icons/${name}`
}

/** The last path segment of a file path (tab/editor icon names). */
export function fileBaseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** The vscode-icons file name for a file (never null — defaults to default_file). */
export function fileIconName(fileName: string): string {
  return getIconForFile(fileName) ?? DEFAULT_FILE
}

/** The vscode-icons file name for a folder in its open/closed state. */
export function folderIconName(folderName: string, open: boolean): string {
  return open ? getIconForOpenFolder(folderName) ?? DEFAULT_FOLDER_OPENED : getIconForFolder(folderName) ?? DEFAULT_FOLDER
}

/** The vscode-icons file name for the explorer root folder. */
export function rootFolderIconName(folderName: string, open: boolean): string {
  // The root folder icons are the "root" variants; the mapping library has
  // no dedicated lookup, so only the default root pair is used.
  return open ? DEFAULT_ROOT_OPENED : DEFAULT_ROOT
}

/** One icon <img> with a fallback: on load failure the fallback glyph shows. */
function IconImg({ src, size, fallback }: { src: string; size: number; fallback: ReactNode }): ReactNode {
  const [failed, setFailed] = useState(false)
  if (failed) return fallback
  return (
    <img
      className={css.fileIcon}
      style={{ width: size, height: size }}
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      onError={() => { setFailed(true) }}
    />
  )
}

/** A per-file-type icon for one explorer row (vscode-icons, outline fallback). */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): ReactNode {
  return <IconImg src={iconUrl(fileIconName(name))} size={size} fallback={<IconCodeOutline16 size={size} />} />
}

/** A per-folder-type icon for one explorer row (vscode-icons, outline fallback). */
export function FolderTypeIcon({ name, open, size = 14 }: { name: string; open: boolean; size?: number }): ReactNode {
  return (
    <IconImg
      src={iconUrl(folderIconName(name, open))}
      size={size}
      fallback={open ? <IconFolderOpen16 size={size} /> : <IconFolderClose16 size={size} />}
    />
  )
}

/** The explorer root row icon (the default root folder pair). */
export function RootFolderIcon({ name, open, size = 14 }: { name: string; open: boolean; size?: number }): ReactNode {
  return (
    <IconImg
      src={iconUrl(rootFolderIconName(name, open))}
      size={size}
      fallback={open ? <IconFolderOpen16 size={size} /> : <IconFolderClose16 size={size} />}
    />
  )
}
