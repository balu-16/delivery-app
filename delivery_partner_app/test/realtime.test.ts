/// <reference types="jest" />
import { io } from 'socket.io-client';
import { getAccessToken } from '../src/auth/session';
import { startRiderRealtime } from '../src/realtime';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));
jest.mock('../src/api', () => ({ apiBase: () => 'https://api.example.test' }));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn() }));

test('reconnects with current credentials and recovers from an expired socket token', async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: false,
    active: false,
    on: jest.fn((event: string, callback: (...args: unknown[]) => void) => { listeners.set(event, callback); }),
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
  jest.mocked(io).mockReturnValue(socket as never);
  jest.mocked(getAccessToken).mockResolvedValueOnce('first-token').mockResolvedValueOnce('new-token').mockResolvedValue('refreshed-token');
  const connected = jest.fn();
  const changed = jest.fn();
  const stop = startRiderRealtime(connected, changed);
  const options = jest.mocked(io).mock.calls[0][1]!;
  const auth = options.auth as (done: (credentials: object) => void) => void;
  expect(await new Promise((resolve) => auth(resolve))).toEqual({ token: 'first-token' });
  expect(await new Promise((resolve) => auth(resolve))).toEqual({ token: 'new-token' });

  listeners.get('connect')?.();
  listeners.get('task.updated')?.();
  expect(connected).toHaveBeenCalledWith(true);
  expect(changed).toHaveBeenCalledTimes(2);

  listeners.get('connect_error')?.(new Error('UNAUTHORIZED'));
  await Promise.resolve();
  await Promise.resolve();
  expect(getAccessToken).toHaveBeenCalledWith(true);
  expect(socket.connect).toHaveBeenCalledTimes(1);
  listeners.get('connect_error')?.(new Error('UNAUTHORIZED'));
  expect(jest.mocked(getAccessToken).mock.calls.filter(([force]) => force)).toHaveLength(1);

  stop();
  expect(socket.disconnect).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
