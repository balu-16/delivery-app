import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type ApiAddressErrorCode = 'BACKEND_CONFIGURATION' | 'BACKEND_DISCOVERY';

export class ApiAddressError extends Error {
  constructor(public readonly code: ApiAddressErrorCode, message: string) {
    super(message);
    this.name = 'ApiAddressError';
  }
}

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

/** Discover local development only; remote and release backends remain explicit. */
export function resolveApiAddress({ configuredUrl, development, developmentHost, developmentPort }: AddressOptions): string {
  const configured = configuredUrl?.trim();
  if (configured) {
    let url: URL;
    try { url = new URL(configured); }
    catch { throw new ApiAddressError('BACKEND_CONFIGURATION', 'EXPO_PUBLIC_API_URL is not a valid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new ApiAddressError('BACKEND_CONFIGURATION', 'EXPO_PUBLIC_API_URL must be an HTTP(S) base URL without credentials or query parameters.');
    if (!development && url.protocol !== 'https:')
      throw new ApiAddressError('BACKEND_CONFIGURATION', 'The customer API must use HTTPS.');
    return url.toString().replace(/\/$/, '');
  }
  if (!development)
    throw new ApiAddressError('BACKEND_CONFIGURATION', 'Set EXPO_PUBLIC_API_URL to the customer backend URL.');
  const port = developmentPort?.trim() || '3000';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new ApiAddressError('BACKEND_CONFIGURATION', 'The customer backend port is invalid.');
  try {
    if (!developmentHost) throw new Error();
    const host = new URL(developmentHost.includes('://') ? developmentHost : `http://${developmentHost}`);
    if (!['http:', 'https:', 'exp:', 'exps:'].includes(host.protocol) || host.username || host.password || !isLocalHost(host.hostname)) throw new Error();
    return `http://${host.hostname}:${Number(port)}`;
  } catch {
    throw new ApiAddressError('BACKEND_DISCOVERY', 'Could not find the local customer server from the Expo connection.');
  }
}

export function developmentHost(): string | null | undefined {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.host;
  return Constants.expoConfig?.hostUri || Constants.experienceUrl;
}

export function developmentPort(): string | undefined {
  const manifestPort: unknown = Constants.expoConfig?.extra?.developmentApiPort;
  return process.env.EXPO_PUBLIC_API_PORT?.trim() || (typeof manifestPort === 'string' ? manifestPort : undefined);
}
