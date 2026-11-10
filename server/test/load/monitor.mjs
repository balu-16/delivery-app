import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';

const root = Number(process.argv[2]);
const output = process.argv[3];
if (!Number.isSafeInteger(root) || root < 1 || !output)
  throw new Error('Usage: node test/load/monitor.mjs <runner-pid> <output.jsonl>');
await mkdir(dirname(output), { recursive: true });
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
async function processes() {
  const all = new Map();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      const cmd = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' ').trim();
      all.set(Number(entry), {
        pid: Number(entry),
        command: cmd,
        ppid: Number(fields[1]),
        userTicks: Number(fields[11]),
        systemTicks: Number(fields[12]),
        rssPages: Number(fields[21]),
      });
    } catch {
      /* Process exited while sampling. */
    }
  }
  const included = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all.values())
      if (included.has(p.ppid) && !included.has(p.pid)) {
        included.add(p.pid);
        grew = true;
      }
  }
  return [...all.values()]
    .filter((p) => included.has(p.pid))
    .map(({ command, ...p }) => ({ ...p, command: command.split(' ').slice(0, 2).join(' ') }));
}
async function dockerStats() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let data = '';
    child.stdout.on('data', (part) => {
      data += part;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolve({ error: 'docker unavailable' });
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return resolve({ error: `docker stats exited ${code}` });
      try {
        resolve(
          data
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      } catch {
        resolve({ error: 'invalid docker stats output' });
      }
    });
  });
}
while (!stopping) {
  const ps = await processes();
  if (!ps.some((p) => p.pid === root)) break;
  const containers = await dockerStats();
  await appendFile(
    output,
    `${JSON.stringify({ at: new Date().toISOString(), rootPid: root, processStats: ps, dockerStats: containers, note: 'CPU times are cumulative kernel ticks; RSS is in system pages. Docker stats include other containers; correlate by ID.' })}\n`,
  );
  await delay(5000);
}
