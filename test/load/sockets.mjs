import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { io } from 'socket.io-client';
import Redis from 'ioredis';

const profiles = {
  local: { sockets: 500, seconds: 300, riders: 100, publishesPerSecond: 100 },
  smoke: { sockets: 4, seconds: 3, riders: 2, publishesPerSecond: 2 },
  staging: { sockets: 5000, seconds: 1800, riders: 5000, publishesPerSecond: 1000 },
};
const p = profiles[process.env.LOAD_PROFILE];
const path = process.env.LOAD_FIXTURE_FILE,
  redisUrl = process.env.REDIS_URL;
const urls = [process.env.RIDER_URL_1, process.env.RIDER_URL_2];
if (!p || !path || !redisUrl || urls.some((u) => !u) || urls[0] === urls[1])
  throw new Error('profile, fixture, Redis and two distinct rider instance URLs required');
const fixture = JSON.parse(await readFile(path, 'utf8'));
if (fixture.riders.length < p.riders) throw new Error('insufficient riders in fixture');
const output = process.env.LOAD_OUTPUT_DIR ?? 'artifacts/p13-load';
await mkdir(output, { recursive: true });
const file = `${output}/sockets-${process.env.LOAD_PROFILE}-${Date.now()}.json`;
const report = {
  profile: process.env.LOAD_PROFILE,
  configured: p,
  startedAt: new Date().toISOString(),
  targets: urls,
  dataset: { riders: fixture.riders.length },
  resources: { cpus: os.cpus().length, memoryBytes: os.totalmem(), host: os.hostname() },
  connected: 0,
  snapshots: 0,
  published: 0,
  received: 0,
  unexpectedErrors: 0,
  disconnects: 0,
  latenciesMs: {},
  exitCode: 1,
};
const sockets = [],
  samples = [],
  expected = new Set(),
  received = new Set();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (let i = 0; i < p.sockets; i++) {
    const rider = fixture.riders[i % p.riders];
    const socket = io(`${urls[i % 2].replace(/\/$/, '')}/rider`, {
      auth: { token: rider.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
      forceNew: true,
    });
    sockets.push(socket);
    socket.on('connect', () => {
      report.connected++;
    });
    socket.once('snapshot', () => {
      report.snapshots++;
    });
    socket.on('connect_error', () => {
      report.unexpectedErrors++;
    });
    socket.on('disconnect', () => {
      report.disconnects++;
      report.unexpectedErrors++;
    });
    socket.on('p13.load', (payload) => {
      const key = `${payload.id}:${i}`;
      if (!expected.has(key) || received.has(key)) {
        report.unexpectedErrors++;
        return;
      }
      received.add(key);
      report.received++;
      samples.push(Date.now() - payload.sentAt);
    });
  }
  const until = performance.now() + 30000;
  while (
    (report.connected < p.sockets || report.snapshots < p.sockets) &&
    performance.now() < until
  )
    await delay(100);
  if (report.connected !== p.sockets || report.snapshots !== p.sockets)
    throw new Error('socket connection or snapshot target not reached');
  // Socket joins its user room asynchronously after connection; snapshot proves readiness.
  const start = performance.now();
  for (let second = 0; second < p.seconds; second++) {
    const wait = start + second * 1000 - performance.now();
    if (wait > 0) await delay(wait);
    for (let j = 0; j < p.publishesPerSecond; j++) {
      const riderIndex = (second * p.publishesPerSecond + j) % p.riders;
      const id = `${second}:${riderIndex}`,
        rider = fixture.riders[riderIndex];
      for (let i = riderIndex; i < p.sockets; i += p.riders) expected.add(`${id}:${i}`);
      await redis.publish(
        'delivery:realtime:events',
        JSON.stringify({
          audience: '/rider',
          room: `user:${rider.id}`,
          event: 'p13.load',
          payload: { id, sentAt: Date.now() },
        }),
      );
      report.published++;
    }
    if (performance.now() > start + (second + 1) * 1000)
      throw new Error('publisher could not sustain requested cadence');
  }
  await delay(2000);
  samples.sort((a, b) => a - b);
  const percentile = (v) => (samples.length ? samples[Math.ceil(samples.length * v) - 1] : null);
  report.latenciesMs = { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
  report.expectedDeliveries = expected.size;
  report.missingDeliveries = expected.size - received.size;
  if (
    !samples.length ||
    report.disconnects > 0 ||
    report.latenciesMs.p95 > 1000 ||
    report.missingDeliveries / expected.size >= 0.001 ||
    report.unexpectedErrors / expected.size >= 0.001
  )
    throw new Error('socket delivery threshold failed');
  report.exitCode = 0;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  for (const socket of sockets) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  redis.disconnect();
  report.endedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Report: ${file}`);
  process.exitCode = report.exitCode;
}
