// Lazy toast proxy — sonner (~14 KB gzip) stays out of the initial bundle and
// loads with the (already lazy) <Toaster/> when the first toast actually fires.
type AnyToast = typeof import('sonner')['toast']

let loadPromise: Promise<typeof import('sonner')> | null = null
function load() {
  if (!loadPromise) loadPromise = import('sonner')
  return loadPromise
}

function method(name: keyof AnyToast) {
  return (...args: never[]) => {
    void load().then((m) => {
      const fn = m.toast[name] as unknown as (...a: never[]) => void
      if (typeof fn === 'function') fn(...args)
      else m.toast(args[0] as string)
    })
  }
}

export const toast = Object.assign(
  ((...args: unknown[]) => { void load().then((m) => (m.toast as unknown as (...a: unknown[]) => void)(...args)) }) as AnyToast,
  {
    success: method('success' as keyof AnyToast),
    error: method('error' as keyof AnyToast),
    info: method('info' as keyof AnyToast),
    warning: method('warning' as keyof AnyToast),
    warning2: method('warning' as keyof AnyToast),
    loading: method('loading' as keyof AnyToast),
    message: method('message' as keyof AnyToast),
    dismiss: method('dismiss' as keyof AnyToast),
  },
)
