import { loadAgentAvailability } from '../src/agent/availability';

test('a transient authentication failure does not permanently hide an available assistant', async () => {
  const request = jest.fn().mockRejectedValueOnce({ status: 401 }).mockResolvedValue({ enabled: true });
  const wait = jest.fn().mockResolvedValue(undefined);
  await expect(loadAgentAvailability(request, wait)).resolves.toEqual({ enabled: true });
  expect(request).toHaveBeenCalledTimes(2);
});

test('an explicitly disabled assistant is not retried or shown as available', async () => {
  const request = jest.fn().mockResolvedValue({ enabled: false });
  await expect(loadAgentAvailability(request)).resolves.toEqual({ enabled: false });
  expect(request).toHaveBeenCalledTimes(1);
});

test('rate limiting is surfaced immediately instead of being retried', async () => {
  const request = jest.fn().mockRejectedValue({ status: 429 });
  await expect(loadAgentAvailability(request)).rejects.toEqual({ status: 429 });
  expect(request).toHaveBeenCalledTimes(1);
});
