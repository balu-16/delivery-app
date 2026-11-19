/// <reference types="jest" />
import { act, renderHook } from '@testing-library/react-native';
import { useRefresh } from '../hooks/useRefresh';

test('duplicate pulls while a refresh is in flight share one load', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const load = jest.fn(() => gate);
  const { result } = await renderHook(() => useRefresh(load));
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = result.current.onRefresh();
    second = result.current.onRefresh();
  });
  expect(second).toBe(first);
  expect(load).toHaveBeenCalledTimes(1);
  expect(result.current.refreshing).toBe(true);
  await act(async () => { release(); await first; await second; });
  expect(result.current.refreshing).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
});

test('a later pull after completion loads again', async () => {
  const load = jest.fn().mockResolvedValue(undefined);
  const { result } = await renderHook(() => useRefresh(load));
  await act(async () => { await result.current.onRefresh(); });
  await act(async () => { await result.current.onRefresh(); });
  expect(load).toHaveBeenCalledTimes(2);
});

test('a rejected load still clears refreshing and keeps updatedAt', async () => {
  const load = jest.fn().mockRejectedValue(new Error('boom'));
  const { result } = await renderHook(() => useRefresh(load));
  const before = result.current.updatedAt;
  await act(async () => { await result.current.onRefresh(); });
  expect(result.current.refreshing).toBe(false);
  expect(result.current.updatedAt).toBe(before);
});

test('updates updatedAt on success and uses the latest load closure', async () => {
  const firstLoad = jest.fn().mockResolvedValue(undefined);
  const nextLoad = jest.fn().mockResolvedValue(undefined);
  const { result, rerender } = await renderHook(({ load }: { load: () => Promise<void> }) => useRefresh(load), {
    initialProps: { load: firstLoad },
  });
  await act(async () => { await result.current.onRefresh(); });
  const afterFirst = result.current.updatedAt;
  await rerender({ load: nextLoad });
  await act(async () => { await result.current.onRefresh(); });
  expect(firstLoad).toHaveBeenCalledTimes(1);
  expect(nextLoad).toHaveBeenCalledTimes(1);
  expect(result.current.updatedAt.getTime()).toBeGreaterThanOrEqual(afterFirst.getTime());
});

test('pull without a load resolves without error', async () => {
  const { result } = await renderHook(() => useRefresh());
  await act(async () => { await result.current.onRefresh(); });
  expect(result.current.refreshing).toBe(false);
});
