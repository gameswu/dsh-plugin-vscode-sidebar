/**
 * Lazy chunk route: serves the client bundle's chunk scripts
 * (/sidebar/bundle/<name>.js). The official /plugins/<id>/client.js route
 * cannot serve arbitrary file names, so the plugin serves its own split
 * bundles (lib/client-<name>.js) here; the client injects the script on
 * first use of the feature that needs it (see src/client/chunk-loader.ts).
 *
 * Caching contract: every response carries `cache-control: no-cache` plus an
 * ETag (content hash, memoized per file by mtime/size) and honors
 * If-None-Match — the browser revalidates each fetch, but a 304 avoids
 * re-downloading multi-MB chunks that did not change (page refresh, HMR
 * re-activation). Same browser-trust fence as every other /sidebar route;
 * only allowlisted chunk names are servable (no path traversal).
 */
import { createHash } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'

/** The chunk names the client may request (mirror of src/client/chunk-loader.ts). */
export const CHUNK_NAMES = ['terminal', 'editor'] as const
export type ChunkName = (typeof CHUNK_NAMES)[number]

/**
 * Extra classic scripts the route serves next to the chunks: the monaco
 * editor worker (lib/client-editor-worker.js, built as a standalone IIFE,
 * loaded by the editor chunk via `new Worker(...)`). NOT part of
 * {@link CHUNK_NAMES} — the chunk loader never materializes them.
 */
export const WORKER_NAMES = ['editor-worker'] as const

/** Everything the /sidebar/bundle route may serve (chunks + workers). */
const SERVED_NAMES: readonly string[] = [...CHUNK_NAMES, ...WORKER_NAMES]

/** Directory of this host-half module (lib/ — the chunk scripts live next to it). */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** sha1 content hash shortened to 12 hex chars (same shape as the client-modules rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

interface ChunkEtag {
  mtimeMs: number
  size: number
  etag: string
}

/** ETag memo: recompute the content hash only when the file's stat changed. */
const etags = new Map<string, ChunkEtag>()

/**
 * The chunk file's ETag (quoted hash), or undefined when the file is
 * missing. Hash is recomputed only when mtime/size changed (hashing a
 * multi-MB chunk per request is wasteful).
 */
async function etagOf(name: string, chunkDir: string): Promise<string | undefined> {
  const path = join(chunkDir, `client-${name}.js`)
  const key = `${chunkDir}:${name}`
  try {
    const info = await stat(path)
    const memo = etags.get(key)
    if (memo !== undefined && memo.mtimeMs === info.mtimeMs && memo.size === info.size) {
      return memo.etag
    }
    const etag = `"${shortHash(await readFile(path))}"`
    etags.set(key, { mtimeMs: info.mtimeMs, size: info.size, etag })
    return etag
  } catch {
    return undefined
  }
}

/**
 * Build the /sidebar/bundle route handler. `fence` is the shared browser-
 * trust check every /sidebar route applies; `chunkDir` is the directory the
 * chunk scripts live in (overridable for tests).
 */
export function createBundleRouteHandler(
  fence: (req: SidebarHttpRequest) => boolean,
  chunkDir: string = LIB_DIR,
): (req: SidebarHttpRequest, res: SidebarHttpResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (!fence(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const match = /^\/sidebar\/bundle\/([a-z0-9-]+)\.js$/.exec(pathname)
    const name = match?.[1]
    if (name === undefined || !SERVED_NAMES.includes(name)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const etag = await etagOf(name, chunkDir)
    if (etag === undefined) {
      // Registered name but unreadable (bundle not built yet): loud 404.
      res.writeHead(404)
      res.end('not found')
      return
    }
    if (req.headers['if-none-match'] === etag) {
      // Revalidation hit: unchanged chunk, no body — avoids re-downloading
      // multi-MB scripts on page refresh / HMR re-activation.
      res.writeHead(304, { 'cache-control': 'no-cache', etag })
      res.end()
      return
    }
    try {
      const body = await readFile(join(chunkDir, `client-${name}.js`))
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        etag,
      })
      res.end(body)
    } catch {
      // Read raced a delete/rebuild between the stat and the read.
      res.writeHead(404)
      res.end('not found')
    }
  }
}

/** Register the /sidebar/bundle route (disposed with the fiber). */
export function registerBundleRoute(ctx: Context, fence: (req: SidebarHttpRequest) => boolean): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/bundle',
    handler: createBundleRouteHandler(fence),
  })
}

/**
 * The directory the vscode-icons SVG set lives in (assets/vscode-icons, next
 * to the published package root — one level above lib/).
 */
const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'vscode-icons')

/**
 * Register the /sidebar/icons/<name>.svg route: serves the vscode-icons SVG
 * files the file explorer renders for per-file-type icons. The client's
 * icon-name mapping (vscode-icons-js) returns plain file names
 * (`file_type_typescript.svg`); the allowlist regex admits only those, so no
 * traversal or arbitrary file read is possible. Same browser-trust fence as
 * every other /sidebar route; a short public cache (the icon set is static
 * for a plugin version).
 */
export function registerIconsRoute(ctx: Context, fence: (req: SidebarHttpRequest) => boolean): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/icons',
    handler: async (req: SidebarHttpRequest, res: SidebarHttpResponse): Promise<void> => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const match = /^\/sidebar\/icons\/([a-z0-9_.-]+\.svg)$/i.exec(pathname)
      const name = match?.[1]
      if (match === null || name === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      try {
        const body = await readFile(join(ICONS_DIR, name))
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        })
        res.end(body)
      } catch {
        // Unknown icon name: 404, and the client falls back to its outline glyph.
        res.writeHead(404)
        res.end('not found')
      }
    },
  })
}
