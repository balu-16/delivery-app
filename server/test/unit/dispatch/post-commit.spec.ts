import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { taskRunner } from '../../../src/modules/dispatch/dispatch.module.js';
import type { Database, TransactionContext } from '../../../src/platform/database/database.js';

it('reports a rejected post-commit dispatch without rejecting the committed operation', async () => {
  const log = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
  const db = {
    transaction: () => ({
      execute: async (work: (tx: TransactionContext) => Promise<unknown>) =>
        work({} as TransactionContext),
    }),
  } as unknown as Database;
  const result = await taskRunner(db)(async () => ({
    result: 'committed',
    effects: [
      async () => {
        throw new Error('unavailable');
      },
    ],
  }));
  await Promise.resolve();
  expect(result).toBe('committed');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Post-commit'), undefined, 'Dispatch');
});
