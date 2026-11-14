import Constants from 'expo-constants';
import { Platform } from 'react-native';

type AddressOptions = {
  configuredUrl?: string;
  development: boolean;
  developmentHost?: string | null;
  developmentPort?: string;
};

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  if (/^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const [first, second] = parts as [number, number, number, number];
    return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168) || (first === 169 && second === 254)
      || (first === 100 && second >= 64 && second <= 127);
  }
  const ipv6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : '';
  return ipv6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(ipv6) || /^fe[89ab][0-9a-f]:/.test(ipv6);
}

/** Resolve only local development addresses automatically; deployed APIs stay explicit. */
export function resolveApiAddress({ configuredUrl, development, developmentHost, developmentPort }: AddressOptions): string {
  const configured = configuredUrl?.trim().replace(/\/+$/, '');
  if (configured) {
    try {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!development && url.protocol !== 'https:')) throw new Error();
      return configured;
    } catch { throw new Error('BACKEND_CONFIGURATION'); }
  }
  if (!development) throw new Error('BACKEND_CONFIGURATION');

  const port = developmentPort?.trim() || '13080';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('BACKEND_CONFIGURATION');
  try {
    if (!developmentHost) throw new Error();
    const host = new URL(developmentHost.includes('://') ? developmentHost : `http://${developmentHost}`);
    if (!['http:', 'https:', 'exp:', 'exps:'].includes(host.protocol) || host.username || host.password || !isLocalHost(host.hostname)) throw new Error();
    return `http://${host.hostname}:${port}`;
  } catch { throw new Error('BACKEND_DISCOVERY'); }
}

export function developmentHost(): string | null | undefined {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.host;
  return Constants.expoConfig?.hostUri || Constants.experienceUrl;
}
