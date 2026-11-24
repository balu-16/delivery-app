import type { SqsJobPointer, SqsLane, SqsReceivedPointer, SqsTransport } from './sqs-transport.js';
import { SqsOperationError } from './sqs-operation-error.js';

export interface SqsBatchResult {
  completed: number;
  failed: number;
  malformed: number;
}

/**
 * A single long-poll batch. The handler must implement durable idempotency and
 * fencing: SQS can deliver duplicates even while visibility is being extended.
 * Errors leave messages unacknowledged for retry and eventual SQS redrive.
 */
export class SqsBatchWorker {
  constructor(
    private readonly transport: Pick<SqsTransport, 'receive' | 'delete' | 'extendVisibility'>,
    private readonly handle: (pointer: SqsJobPointer, receiveCount: number) => Promise<void>,
    private readonly onError: (error: Error) => void = () => undefined,
    private readonly batchSize = 10,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10)
      throw new Error('INVALID_SQS_BATCH_SIZE');
  }

  async runOnce(lane: SqsLane, abortSignal?: AbortSignal): Promise<SqsBatchResult> {
    const batch = await this.transport.receive(lane, abortSignal, this.batchSize);
    const outcomes = await Promise.all(
      batch.messages.map((message) => this.process(lane, message)),
    );
    return {
      completed: outcomes.filter(Boolean).length,
      failed: outcomes.filter((success) => !success).length,
      malformed: batch.malformedCount,
    };
  }

  private async process(lane: SqsLane, message: SqsReceivedPointer): Promise<boolean> {
    let heartbeat: Promise<void> | undefined;
    let stopped = false;
    let handled = false;
    const timer = setInterval(() => {
      if (stopped || heartbeat) return;
      heartbeat = this.transport
        .extendVisibility(lane, message.receiptHandle, 120)
        .catch((cause) => {
          this.report(
            new SqsOperationError(
              'SQS_VISIBILITY_EXTENSION_FAILED',
              'sqs',
              'extend-visibility',
              lane,
              cause,
            ),
          );
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, 40_000);
    timer.unref();
    try {
      await this.handle(message.pointer, message.receiveCount);
      handled = true;
      stopped = true;
      clearInterval(timer);
      await heartbeat;
      await this.transport.delete(lane, message.receiptHandle);
      return true;
    } catch (cause) {
      this.report(
        handled
          ? new SqsOperationError('SQS_ACKNOWLEDGEMENT_FAILED', 'sqs', 'delete', lane, cause)
          : new SqsOperationError('SQS_JOB_PROCESSING_FAILED', 'handler', 'process', lane, cause),
      );
      return false;
    } finally {
      stopped = true;
      clearInterval(timer);
      await heartbeat;
    }
  }

  private report(error: SqsOperationError): void {
    try {
      this.onError(error);
    } catch {
      /* Reporting must not acknowledge a failed job. */
    }
  }
}
