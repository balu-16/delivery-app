import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveBackendPort } = require('../scripts/backend-port.cjs');

test('reads only the listening port from the backend environment and supports an override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dairydirect-api-port-'));
  const serverEnvPath = join(directory, '.env');
  try {
    writeFileSync(serverEnvPath, 'PORT=13080\nDATABASE_URL=private-test-value\n');
    expect(resolveBackendPort({ serverEnvPath })).toBe('13080');
    writeFileSync(serverEnvPath, 'PORT=3456\nDATABASE_URL=private-test-value\n');
    expect(resolveBackendPort({ serverEnvPath })).toBe('3456');
    expect(resolveBackendPort({ serverEnvPath, explicitPort: '8080' })).toBe('8080');
    writeFileSync(serverEnvPath, 'DATABASE_URL=private-test-value\n');
    expect(resolveBackendPort({ serverEnvPath })).toBe('3000');
    expect(() => resolveBackendPort({ serverEnvPath, explicitPort: '70000' })).toThrow('between 1 and 65535');
    expect(resolveBackendPort({ serverEnvPath: join(directory, 'missing') })).toBe('3000');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
