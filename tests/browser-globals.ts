/**
 * Browser globals for specs that pull browser-bound modules. Import this
 * FIRST in a spec file: unlike statements after imports (which vitest
 * hoists above the module body), an import statement evaluates in order,
 * so this runs before any later import's module graph (xterm's UMD wrapper
 * checks `self` and its color defaults probe `document` at evaluation time;
 * window/localStorage are only touched at runtime by the store).
 */
const g = globalThis as Record<string, unknown>

if (g.self === undefined) g.self = globalThis

// DOM classes monaco references at module scope (extends checks, instanceof
// guards, feature probes). Minimal inert stubs — the specs never exercise
// real layout.
class StubEvent {}
class StubElement {}
class StubHTMLElement extends StubElement {}
if (g.HTMLElement === undefined) g.HTMLElement = StubHTMLElement
if (g.HTMLDivElement === undefined) g.HTMLDivElement = StubHTMLElement
if (g.HTMLTextAreaElement === undefined) g.HTMLTextAreaElement = StubHTMLElement
if (g.HTMLCanvasElement === undefined) g.HTMLCanvasElement = StubHTMLElement
if (g.Element === undefined) g.Element = StubElement
if (g.Node === undefined) g.Node = StubElement
if (g.Event === undefined) g.Event = StubEvent
if (g.CustomEvent === undefined) g.CustomEvent = StubEvent
if (g.KeyboardEvent === undefined) g.KeyboardEvent = StubEvent
if (g.MouseEvent === undefined) g.MouseEvent = StubEvent
if (g.WheelEvent === undefined) g.WheelEvent = StubEvent
if (g.UIEvent === undefined) g.UIEvent = StubEvent
if (g.PointerEvent === undefined) g.PointerEvent = StubEvent
if (g.DragEvent === undefined) g.DragEvent = StubEvent
if (g.MutationObserver === undefined) g.MutationObserver = class { observe(): void {}; disconnect(): void {}; takeRecords(): unknown[] { return [] } }
if (g.ResizeObserver === undefined) g.ResizeObserver = class { observe(): void {}; unobserve(): void {}; disconnect(): void {} }
if (g.IntersectionObserver === undefined) g.IntersectionObserver = class { observe(): void {}; unobserve(): void {}; disconnect(): void {} }
if (g.requestAnimationFrame === undefined) g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0) as unknown as number
if (g.cancelAnimationFrame === undefined) g.cancelAnimationFrame = (id: number) => { clearTimeout(id) }
if (g.matchMedia === undefined) g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
if (g.customElements === undefined) g.customElements = { define: () => {}, get: () => undefined }

const elementStub = (): Record<string, unknown> => ({
  style: {},
  dataset: {},
  textContent: '',
  classList: { add: () => {}, remove: () => {}, contains: () => false },
  setAttribute: () => {},
  getAttribute: () => null,
  hasAttribute: () => false,
  appendChild: () => {},
  append: () => {},
  prepend: () => {},
  remove: () => {},
  insertBefore: () => {},
  cloneNode: () => elementStub(),
  contains: () => false,
  matches: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  // xterm's color palette probe measures a canvas context at module load.
  getContext: () => null,
})

if (g.document === undefined) {
  g.document = {
    createElement: () => elementStub(),
    createElementNS: () => elementStub(),
    createDocumentFragment: () => elementStub(),
    createRange: () => ({
      selectNodeContents: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    }),
    queryCommandSupported: () => false,
    queryCommandEnabled: () => false,
    execCommand: () => false,
    addEventListener: () => {},
    removeEventListener: () => {},
    defaultView: globalThis,
    body: elementStub(),
    // CodeMirror's view module probes the UA and injects styles at load;
    // the plugin's css-inline prologue probes for existing style tags.
    documentElement: elementStub(),
    head: elementStub(),
    querySelector: () => null,
    querySelectorAll: () => [],
    styleSheets: [],
    activeElement: null,
  }
}

if (g.navigator === undefined) {
  g.navigator = { userAgent: 'node', platform: 'node', vendor: '', maxTouchPoints: 0 }
}

// monaco's platform module reads location.href at module scope.
if (g.location === undefined) {
  g.location = { href: 'http://localhost/' }
}

if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: g.location,
  }
}

if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}
