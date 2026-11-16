import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeEach, vi } from 'vitest'
import { installMockServer, resetRoutes, stateFlags } from './mockServer'

// ── Browser API polyfills for jsdom ──────────────────────────────────────────
if (typeof window !== 'undefined') {
  if (!('BroadcastChannel' in window)) {
    class MockBroadcastChannel {
      static instances: MockBroadcastChannel[] = []
      onmessage: ((ev: MessageEvent) => void) | null = null
      name: string
      constructor(name: string) {
        this.name = name
        MockBroadcastChannel.instances.push(this)
      }
      postMessage(message: unknown) {
        for (const instance of MockBroadcastChannel.instances) {
          if (instance !== this) {
            instance.onmessage?.(new MessageEvent('message', { data: message }))
          }
        }
      }
      close() { /* noop */ }
    }
    ;(window as unknown as { BroadcastChannel: unknown }).BroadcastChannel = MockBroadcastChannel
  }

  window.matchMedia = window.matchMedia ?? ((query: string) => ({
    // Report prefers-reduced-motion as MATCHED so count-up KPIs render final
    // values instantly (deterministic assertions, no rAF timing flake).
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))

  window.IntersectionObserver = window.IntersectionObserver ?? (class {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
    takeRecords() { return [] }
    root = null
    rootMargin = ''
    thresholds = []
  } as unknown as typeof IntersectionObserver)

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined
  }
  if (!('randomUUID' in crypto)) {
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => 'test-00000000-0000-4000-8000-000000000000',
      configurable: true,
    })
  }
}

// ── Test mode ────────────────────────────────────────────────────────────────
// REAL mode (primary): tests import src/test/serverProbe.ts and skipIf the
// server is unreachable — they run against the real backend contract.
// FALLBACK mode (labeled): a handful of component tests use the labeled
// fetch stub (src/test/mockServer.ts) so component behavior remains covered
// when the server + DB are down. The stub is NEVER part of the app itself.
// The labeled fallback stub is installed FIRST so offline component tests
// have transport. REAL-mode suites call setupRealMode() (serverProbe.ts),
// which overrides globalThis.fetch with the real transport — real data wins.
beforeEach(() => {
  resetRoutes()
  stateFlags.cod = true
  stateFlags.wallets = true
  stateFlags.subscriptions = true
  try { window.localStorage.clear() } catch { /* noop */ }
  try { window.sessionStorage.clear() } catch { /* noop */ }
})

installMockServer()

afterEach(() => {
  document.querySelectorAll('[data-sonner-toast]').forEach((el) => el.remove())
})

afterAll(() => {
  vi.restoreAllMocks()
})
