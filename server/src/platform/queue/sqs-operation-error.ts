import type { SqsLane } from './sqs-transport.js';

export class SqsOperationError extends Error {
  constructor(
    code: string,
    readonly dependency: 'sqs' | 'postgres' | 'handler',
    readonly operation: string,
    readonly lane: SqsLane | undefined,
    cause: unknown,
  ) {
    super(code, { cause });
  }
}
