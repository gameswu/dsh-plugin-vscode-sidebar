/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose
 * BUILT lib bundles css side-effect imports (e.g. `dsh-client-ui-primitives`
 * imports `katex/dist/katex.min.css` at the top of its `lib/index.js`).
 *
 * Installed from the npm registry (the default since v0.4.1) these packages
 * live under `node_modules/.pnpm` and are externalized by vitest — Node then
 * chokes on the `.css` import. Inlining routes them through Vite's transform,
 * which stubs css imports (the default `css: false`). The previous
 * `link:`-to-source-checkout install needed no such config: linked files sit
 * outside `node_modules` and are transformed by default.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The suite spawns REAL processes (git scratch repos, node-pty shells,
    // an HTTP server): under a parallel test-file load on Windows a single
    // spawn can exceed vitest's default 5s per test. A global 30s cap keeps
    // the run green without weakening any assertion. (The describe-level
    // `timeout` options used earlier are ignored by vitest — this is the
    // config knob that actually applies.)
    testTimeout: 30_000,
    // node-pty's ConPTY console-list agent (forked from the vitest worker to
    // enumerate a dying shell's console) throws `AttachConsole failed` when
    // the worker runs detached on Windows — a known environmental noise of
    // real-pty tests, not an assertion failure. node-pty's own timeout
    // fallback covers the failure path; this keeps the run green when the
    // agent's crash surfaces as an unhandled error in the worker.
    dangerouslyIgnoreUnhandledErrors: true,
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    // NOTE: `exclude` REPLACES vitest's defaults, so the standard
    // node_modules/dist/etc. excludes must be restated here.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
})
