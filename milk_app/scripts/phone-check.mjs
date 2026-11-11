import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env;
try { env = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8')); }
catch { console.error('Create milk_app/.env.local from .env.example and set EXPO_PUBLIC_API_URL.'); process.exit(1); }
let api;
try { api = new URL(env.EXPO_PUBLIC_API_URL); }
catch { console.error('EXPO_PUBLIC_API_URL must be a valid customer API URL.'); process.exit(1); }
if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash || api.pathname !== '/') {
  console.error('EXPO_PUBLIC_API_URL must be an HTTP(S) base URL without credentials or a path.'); process.exit(1);
}
const selected = Object.entries(networkInterfaces()).find(([, items]) =>
  items?.some((item) => item.family === 'IPv4' && !item.internal && item.address === api.hostname),
);
if (!selected || /^(tun|tap|wg|tailscale|cloudflarewarp)/i.test(selected[0])) {
  console.error(`The configured API host (${api.hostname}) is not an active LAN IPv4 address on this computer. Use the Wi-Fi address, not localhost or a VPN-only address.`);
  process.exit(1);
}
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

async function check(name, url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(name === 'API readiness' ? 18000 : 4000) });
    const body = await response.text();
    const ok = response.ok && expected(body);
    console.log(`${name}: ${ok ? 'OK' : `not ready (HTTP ${response.status})`}`);
    return ok;
  } catch { console.log(`${name}: unreachable`); return false; }
}
const [health, readiness, metro] = await Promise.all([
  check('Customer API', new URL('/healthz', api), (body) => body.includes('"ok"')),
  check('API readiness', new URL('/readyz', api), (body) => body.includes('"ok"')),
  check('Metro', `http://${api.hostname}:8081/status`, (body) => body.includes('packager-status:running')),
]);
console.log(`Expo Go address: exp://${api.hostname}:8081`);
if (!health || !readiness || !metro) {
  console.log('See milk_app/README.md for the two startup terminals, Wi-Fi and VPN checks.');
  process.exitCode = 1;
}
