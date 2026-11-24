import { jest } from '@jest/globals';
import type { Database } from '../../../src/platform/database/database.js';
import { SqsConcernQueues } from '../../../src/platform/queue/sqs-concern-queues.js';
import type { SqsTransport } from '../../../src/platform/queue/sqs-transport.js';

test('waits for application bootstrap before relaying persisted schedules', async () => {
  jest.useFakeTimers();
  const queues = new SqsConcernQueues({ db: {} as Database, transport: {} as SqsTransport });
  const relay = jest.spyOn(queues, 'relayOnce').mockResolvedValue(undefined);
  try {
    await jest.advanceTimersByTimeAsync(2000);
    expect(relay).not.toHaveBeenCalled();
    queues.startRelay();
    await jest.advanceTimersByTimeAsync(1000);
    expect(relay).toHaveBeenCalledTimes(1);
  } finally {
    await queues.close();
    jest.useRealTimers();
  }
});
