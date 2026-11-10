import { jest } from '@jest/globals';
import { SqsBatchWorker } from '../../../src/platform/queue/sqs-batch-worker.js';
import type { SqsReceiveResult } from '../../../src/platform/queue/sqs-transport.js';

const pointer = { version: 1 as const, jobId: 'job_1', generation: 1 };
function setup(batch: SqsReceiveResult) {
  const receive = jest.fn<() => Promise<SqsReceiveResult>>().mockResolvedValue(batch);
  const remove = jest.fn<() => Promise<void>>().mockResolvedValue();
  const extendVisibility = jest.fn<() => Promise<void>>().mockResolvedValue();
  const handle = jest.fn<() => Promise<void>>().mockResolvedValue();
  const report = jest.fn<(error: Error) => void>();
  const worker = new SqsBatchWorker({ receive, delete: remove, extendVisibility }, handle, report);
  return { worker, receive, remove, extendVisibility, handle, report };
}
const message = { pointer, receiptHandle: 'receipt', receiveCount: 2 };

test('deletes only after the handler succeeds and leaves malformed messages for redrive', async () => {
  const { worker, handle, remove } = setup({ messages: [message], malformedCount: 1 });
  await expect(worker.runOnce('payments')).resolves.toEqual({
    completed: 1,
    failed: 0,
    malformed: 1,
  });
  expect(handle).toHaveBeenCalledWith(pointer, 2);
  expect(remove).toHaveBeenCalledWith('payments', 'receipt');
  expect(handle.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
});

test('does not acknowledge a failed handler and does not leak handler errors', async () => {
  const { worker, handle, remove, report } = setup({ messages: [message], malformedCount: 0 });
  handle.mockRejectedValue(new Error('secret in error'));
  await expect(worker.runOnce('payments')).resolves.toEqual({
    completed: 0,
    failed: 1,
    malformed: 0,
  });
  expect(remove).not.toHaveBeenCalled();
  expect(report.mock.calls[0]?.[0].message).toBe('SQS_JOB_PROCESSING_FAILED');
});

test('extends visibility while the handler runs and stops heartbeats before acknowledgement', async () => {
  jest.useFakeTimers();
  try {
    const { worker, handle, remove, extendVisibility } = setup({
      messages: [message],
      malformedCount: 0,
    });
    let finish!: () => void;
    handle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const result = worker.runOnce('payments');
    await jest.advanceTimersByTimeAsync(40_000);
    expect(extendVisibility).toHaveBeenCalledWith('payments', 'receipt', 120);
    expect(remove).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toEqual({ completed: 1, failed: 0, malformed: 0 });
    await jest.advanceTimersByTimeAsync(80_000);
    expect(extendVisibility).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
