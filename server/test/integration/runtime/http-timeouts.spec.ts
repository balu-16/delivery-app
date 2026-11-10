import { connect } from 'node:net';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';

it('closes an incomplete header request within the configured idle receive deadline', async () => {
  const app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'worker',
      LOG_LEVEL: 'silent',
      HTTP_HEADERS_TIMEOUT_MS: '1000',
      HTTP_REQUEST_TIMEOUT_MS: '2000',
    }),
    [],
  );
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const socket = connect(address.port, '127.0.0.1');
  socket.resume();
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const started = Date.now();
    socket.write('GET /healthz HTTP/1.1\r\nHost: local');
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Receive deadline did not close connection')),
        4000,
      );
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    expect(Date.now() - started).toBeLessThan(3500);
  } finally {
    if (timer) clearTimeout(timer);
    socket.destroy();
    await app.close();
  }
});

it('expires a trickling header request even while bytes keep the connection active', async () => {
  const app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'worker',
      LOG_LEVEL: 'silent',
      HTTP_HEADERS_TIMEOUT_MS: '1000',
      HTTP_REQUEST_TIMEOUT_MS: '2000',
    }),
    [],
  );
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const socket = connect(address.port, '127.0.0.1');
  socket.resume();
  let interval: NodeJS.Timeout | undefined, timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write('GET /healthz HTTP/1.1\r\nHost: local\r\nX-Slow: ');
    interval = setInterval(() => socket.write('a'), 150);
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Trickling request exceeded receive deadline')),
        4000,
      );
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    expect(Date.now() - started).toBeLessThan(3500);
  } finally {
    if (interval) clearInterval(interval);
    if (timer) clearTimeout(timer);
    socket.destroy();
    await app.close();
  }
});
