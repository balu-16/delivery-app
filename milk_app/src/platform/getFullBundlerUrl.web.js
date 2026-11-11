export function getFullBundlerUrl() {
  const current = document.currentScript;
  const entry = Array.from(document.scripts).find((script) =>
    /\/entry(?:\.bundle|-[^/]+\.js)(?:\?|$)/.test(script.src),
  );
  const url = new URL(current?.src || entry?.src || location.href, location.href);
  if (!url.searchParams.has('platform')) {
    url.searchParams.set('platform', process.env.EXPO_OS ?? 'web');
  }
  return url.toString();
}
