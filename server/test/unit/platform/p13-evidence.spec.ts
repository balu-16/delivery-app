import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const verifier = resolve('scripts/verify-p13-evidence.mjs');

it('requires successful operation behavior as well as the security criteria for acceptance', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'p13-evidence-'));
  try {
    for (const dir of ['docs/manifests', 'test/security', 'test/unit'])
      mkdirSync(resolve(root, dir), { recursive: true });
    const covered = { status: 'covered', test: 'test/unit/example.spec.ts: passes' };
    const item = {
      method: 'GET',
      path: '/v1/example',
      authentication: covered,
      authorization: covered,
      validation: covered,
      replay: covered,
      success: { status: 'unassessed', reason: 'No passing success test is mapped.' },
    };
    const write = (path: string, data: unknown) =>
      writeFileSync(resolve(root, path), JSON.stringify(data));
    write('docs/manifests/operations.json', { items: [item] });
    write('test/security/operation-cases.json', { items: [item] });
    write('test/security/edge-case-evidence.json', { cases: [] });
    writeFileSync(resolve(root, 'docs/EDGE_CASES.md'), '');
    writeFileSync(resolve(root, 'test/unit/example.spec.ts'), '');
    write('results.json', {
      success: true,
      testResults: [
        {
          name: resolve(root, 'test/unit/example.spec.ts'),
          assertionResults: [{ title: 'passes', status: 'passed' }],
        },
      ],
    });
    const run = () =>
      spawnSync(process.execPath, [verifier, '--strict', '--results', 'results.json'], {
        cwd: root,
        encoding: 'utf8',
      });
    const incomplete = run();
    expect(incomplete.status).toBe(1);
    expect(JSON.parse(incomplete.stdout).criteria.success.unassessed).toBe(1);
    write('test/security/operation-cases.json', { items: [{ ...item, success: covered }] });
    expect(run().status).toBe(0);
    write('results.json', {
      success: true,
      testResults: [
        {
          name: resolve(root, 'test/unit/example.spec.ts'),
          assertionResults: [{ title: 'passes', status: 'failed' }],
        },
      ],
    });
    expect(run().status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
