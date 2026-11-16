/// <reference types="jest" />
import { io } from 'socket.io-client';
import { accessToken } from '../src/auth/session';
import { startOrderRealtime } from '../src/orderRealtime';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));
jest.mock('../src/api/client', () => ({ apiBaseUrl: () => 'https://api.example.test' }));
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn() }));

test('refreshes the socket credential and reconnects after a server disconnect', async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket = { connected: false, active: false, emit: jest.fn(), connect: jest.fn(), disconnect: jest.fn(),
    on: jest.fn((name: string, callback: (...args: unknown[]) => void) => { listeners.set(name, callback); }) };
  jest.mocked(io).mockReturnValue(socket as never);
  jest.mocked(accessToken).mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token').mockResolvedValue('refreshed-token');
  const changed = jest.fn(), status = jest.fn();
  const stop = startOrderRealtime('order-1', changed, status);
  const auth = jest.mocked(io).mock.calls[0][1]!.auth as (done: (value: object) => void) => void;
  expect(await new Promise((resolve) => auth(resolve))).toEqual({ token: 'old-token' });
  expect(await new Promise((resolve) => auth(resolve))).toEqual({ token: 'new-token' });
  listeners.get('connect')?.();
  expect(socket.emit).toHaveBeenCalledWith('subscribe', { room: 'order:order-1' });
  listeners.get('order.status')?.();
  expect(status).toHaveBeenCalled();
  listeners.get('disconnect')?.('io server disconnect');
  expect(socket.connect).toHaveBeenCalledTimes(1);
  listeners.get('connect_error')?.(new Error('UNAUTHORIZED'));
  await Promise.resolve(); await Promise.resolve();
  expect(accessToken).toHaveBeenCalledWith(true);
  expect(socket.connect).toHaveBeenCalledTimes(2);
  stop();
  expect(socket.disconnect).toHaveBeenCalled();
  jest.useRealTimers();
});
