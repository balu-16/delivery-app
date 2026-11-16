const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseEnv } = require('node:util');

/** Resolve only the public listening port; do not expose other server settings. */
function resolveBackendPort({ explicitPort, serverEnvPath } = {}) {
  let port = explicitPort?.trim();
  if (!port) {
    const path = serverEnvPath ?? resolve(__dirname, '../../server/.env');
    try {
      port = parseEnv(readFileSync(path, 'utf8')).PORT?.trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Could not read the local backend port.');
    }
  }
  // Match the backend's fallback when its .env file has no PORT setting.
  port ||= '3000';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('The local backend port must be between 1 and 65535.');
  return String(Number(port));
}

module.exports = { resolveBackendPort };
