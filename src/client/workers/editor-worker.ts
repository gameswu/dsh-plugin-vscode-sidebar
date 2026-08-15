/**
 * Monaco's editor worker entry: bundled as a self-contained IIFE classic
 * script (lib/client-editor-worker.js) and served by the plugin's
 * /sidebar/bundle route. The editor chunk loads it through
 * `new Worker(...)` via MonacoEnvironment.getWorker — it hosts the
 * editorWorkerService (diff computation, find/replace internals) so the
 * editor never tries to load a CDN worker. Syntax highlighting is
 * main-thread (Monarch tokenizers) and does not depend on this worker.
 */
import 'monaco-editor/editor/editor.worker.js'
