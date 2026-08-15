/**
 * Lazy chunk entry: the standard VSCode editor (Monaco) for the code /
 * markdown / html text viewers. Built as `lib/client-editor.js` and
 * registered under `dsh-plugin-vscode-sidebar/editor` — fetched only when a
 * text file is first opened (see chunk-loader.ts).
 *
 * The chunk wires MonacoEnvironment to the plugin-served editor worker
 * (lib/client-editor-worker.js, a self-contained IIFE on the /sidebar/bundle
 * route — no CDN), and side-effect-imports the package root, which registers
 * monaco's FULL language-definition set so every supported file type gets
 * syntax highlighting out of the box.
 *
 * Never import this module from the core bundle: it pulls Monaco into the
 * startup path.
 */
import { EDITOR_WORKER_URL } from '../chunk-loader.ts'
import 'monaco-editor'

// Every worker request routes to the plugin-served editor worker (only the
// editorWorkerService label ever asks; the language definitions registered
// above are main-thread tokenizers and need no per-language workers).
;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new Worker(EDITOR_WORKER_URL),
}

export { TextEditor } from '../TextEditor.tsx'
