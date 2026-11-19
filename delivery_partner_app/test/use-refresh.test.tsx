/// <reference types="jest" />
import { act, renderHook } from '@testing-library/react-native';
import { useRefresh } from '../src/useRefresh';

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

test('a later pull after completion loads again and a rejection clears refreshing', async () => {
  const load = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('boom'));
  const { result } = await renderHook(() => useRefresh(load));
  await act(async () => { await result.current.onRefresh(); });
  expect(result.current.refreshing).toBe(false);
  await act(async () => { await result.current.onRefresh(); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.current.refreshing).toBe(false);
});

test('uses the latest load closure after rerender', async () => {
  const firstLoad = jest.fn().mockResolvedValue(undefined);
  const nextLoad = jest.fn().mockResolvedValue(undefined);
  const { result, rerender } = await renderHook(({ load }: { load: () => Promise<void> }) => useRefresh(load), {
    initialProps: { load: firstLoad },
  });
  await rerender({ load: nextLoad });
  await act(async () => { await result.current.onRefresh(); });
  expect(firstLoad).not.toHaveBeenCalled();
  expect(nextLoad).toHaveBeenCalledTimes(1);
});
