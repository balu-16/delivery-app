import { readFile, stat } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import backendPort from './backend-port.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env = {};
try { env = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const configuredUrl = (process.env.EXPO_PUBLIC_API_URL ?? env.EXPO_PUBLIC_API_URL ?? '').trim();
let api;
if (configuredUrl) {
  try { api = new URL(configuredUrl); }
  catch { console.error('EXPO_PUBLIC_API_URL must be a valid customer API URL.'); process.exit(1); }
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash) {
    console.error('EXPO_PUBLIC_API_URL must be an HTTP(S) base URL without credentials or query parameters.'); process.exit(1);
  }
}

const interfaces = Object.entries(networkInterfaces()).flatMap(([name, items]) =>
  /^(tun|tap|wg|tailscale|cloudflarewarp|docker|br-|veth|virbr|vmnet|vboxnet)/i.test(name) ? [] :
    (items ?? []).filter((item) => item.family === 'IPv4' && !item.internal).map((item) => ({ name, address: item.address })),
);
const requestedHost = process.env.REACT_NATIVE_PACKAGER_HOSTNAME?.trim();
let selected = requestedHost ? interfaces.find((item) => item.address === requestedHost) : undefined;
if (requestedHost && !selected) {
  console.error('REACT_NATIVE_PACKAGER_HOSTNAME is not an active LAN IPv4 address on this computer.'); process.exit(1);
}
selected ??= interfaces.find((item) => item.address === api?.hostname);
if (!selected && interfaces.length === 1) selected = interfaces[0];
if (!selected && interfaces.length > 1) {
  // UDP connect selects a local route without sending a packet.
  const socket = createSocket('udp4');
  try {
    await new Promise((resolveRoute, rejectRoute) => {
      socket.once('error', rejectRoute);
      socket.connect(53, '192.0.2.1', resolveRoute);
    });
    selected = interfaces.find((item) => item.address === socket.address().address);
  } catch { /* Report ambiguity below. */ }
  finally { socket.close(); }
}
if (!selected) {
  console.error('Could not identify the Wi-Fi or wired LAN address. Connect to the same network as the phone and retry.'); process.exit(1);
}

const metroPort = process.env.RCT_METRO_PORT?.trim() || '8081';
if (!/^\d{1,5}$/.test(metroPort) || Number(metroPort) < 1 || Number(metroPort) > 65535) {
  console.error('The Metro port is invalid.'); process.exit(1);
}
const metroOrigin = `http://${selected.address}:${Number(metroPort)}`;
let manifest;
try {
  const response = await fetch(`${metroOrigin}/`, { headers: { Accept: 'application/json', 'Expo-Platform': 'android' }, signal: AbortSignal.timeout(4000) });
  if (response.ok) manifest = await response.json();
} catch { /* The Metro status check below reports an unavailable server. */ }
if (!api) {
  const manifestPort = manifest?.extra?.expoClient?.extra?.developmentApiPort;
  let port;
  try { port = backendPort.resolveBackendPort({ explicitPort: typeof manifestPort === 'string' ? manifestPort : (process.env.EXPO_PUBLIC_API_PORT ?? env.EXPO_PUBLIC_API_PORT) }); }
  catch (error) { console.error(error.message); process.exit(1); }
  api = new URL(`http://${selected.address}:${port}`);
}
if (interfaces.some((item) => item.address === api.hostname)) {
  try { await stat(resolve(root, '../server/dist/main.js')); console.log('Compiled customer API: present'); }
  catch { console.error('No compiled API was found at server/dist/main.js. Do not start a build without approval.'); process.exit(1); }
  for (const relative of ['src/modules/identity/infrastructure/customer-group-sync', 'src/modules/identity/infrastructure/identity-service']) {
    try {
      const source = await stat(resolve(root, '../server', `${relative}.ts`));
      const compiled = await stat(resolve(root, '../server/dist', `${relative.slice(4)}.js`));
      if (source.mtimeMs <= compiled.mtimeMs) continue;
    } catch { /* A missing compiled module means it is not in the running artifact. */ }
    console.log('The compiled API may be older than the server source. The current phone test uses the existing artifact.');
    break;
  }
}

async function check(name, url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(name === 'API readiness' ? 25000 : 4000) });
    const body = await response.text();
    const ok = response.ok && expected(body);
    console.log(`${name}: ${ok ? 'OK' : `not ready (HTTP ${response.status})`}`);
    return ok;
  } catch { console.log(`${name}: unreachable`); return false; }
}
const [health, readiness, metro] = await Promise.all([
  check('Customer API', new URL('/healthz', api), (body) => body.includes('"ok"')),
  check('API readiness', new URL('/readyz', api), (body) => body.includes('"ok"')),
  check('Metro', `${metroOrigin}/status`, (body) => body.includes('packager-status:running')),
]);
console.log(`Customer API address: ${api.origin}`);
console.log(`Expo Go address: exp://${selected.address}:${Number(metroPort)}`);
if (!health || !readiness || !metro) {
  console.log('See milk_app/README.md for the two startup terminals, Wi-Fi and VPN checks.');
  process.exitCode = 1;
}
