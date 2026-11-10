import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import {
  CreateQueueCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQS_LANES, SqsTransport, type SqsQueueUrls } from '../src/platform/queue/sqs-transport.js';

/** Temporary queues prevent a test consumer from losing unrelated development messages. */
async function main() {
  if (process.env.AWS_P13_TEMP_QUEUES !== 'yes' || process.env.NODE_ENV !== 'development')
    throw new Error('This test requires AWS_P13_TEMP_QUEUES=yes in development');
  const region = process.env.AWS_REGION;
  const account = process.env.AWS_ACCOUNT_ID;
  if (!region || !account || !/^[0-9]{12}$/.test(account))
    throw new Error('Missing AWS account or region');
  const prefix = `p13-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const manifest = `artifacts/${prefix}-queues.json`;
  const client = new SQSClient({ region });
  const created: string[] = [];
  const urls: Partial<SqsQueueUrls> = {};
  const deadLetters: Partial<SqsQueueUrls> = {};
  const persist = async () => {
    await mkdir('artifacts', { recursive: true });
    await writeFile(manifest, JSON.stringify({ prefix, region, account, urls: created }, null, 2), {
      mode: 0o600,
    });
    await chmod(manifest, 0o600);
  };
  const create = async (name: string, attributes: Record<string, string>) => {
    const result = await client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    if (!result.QueueUrl) throw new Error(`Missing URL for ${name}`);
    created.push(result.QueueUrl);
    await persist();
    return result.QueueUrl;
  };
  let failure: unknown;
  try {
    for (const lane of SQS_LANES) {
      const dlq = await create(`${prefix}-${lane}-dlq`, { MessageRetentionPeriod: '86400' });
      deadLetters[lane] = dlq;
      const attributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
      );
      const arn = attributes.Attributes?.QueueArn;
      if (!arn) throw new Error(`Missing dead-letter ARN for ${lane}`);
      urls[lane] = await create(`${prefix}-${lane}`, {
        VisibilityTimeout: '2',
        MessageRetentionPeriod: '86400',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '2' }),
      });
    }
    const transport = new SqsTransport(client, urls as SqsQueueUrls, region, account, prefix);
    for (const lane of SQS_LANES) {
      const pointer = {
        version: 1 as const,
        jobId: randomUUID().replaceAll('-', ''),
        generation: 1,
      };
      await transport.ping(lane);
      await transport.send(lane, pointer);
      const first = await transport.receive(lane, undefined, 1);
      assert.equal(first.malformedCount, 0);
      assert.equal(first.messages.length, 1);
      assert.deepEqual(first.messages[0]?.pointer, pointer);
      assert.equal(first.messages[0]?.receiveCount, 1);
      await transport.extendVisibility(lane, first.messages[0]!.receiptHandle, 0);
      const second = await transport.receive(lane, undefined, 1);
      assert.equal(second.messages.length, 1);
      assert.deepEqual(second.messages[0]?.pointer, pointer);
      assert.ok(second.messages[0]!.receiveCount >= 2);
      await transport.delete(lane, second.messages[0]!.receiptHandle);
      console.log(`${lane}: send, receive, retry and acknowledgement passed`);
    }
    const source = urls.maintenance!;
    const deadLetter = deadLetters.maintenance!;
    const body = `malformed-p13-${randomUUID()}`;
    await client.send(new SendMessageCommand({ QueueUrl: source, MessageBody: body }));
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: source,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 2,
        }),
      );
      assert.equal(response.Messages?.[0]?.Body, body);
      assert.ok(response.Messages?.[0]?.ReceiptHandle);
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: source,
          ReceiptHandle: response.Messages[0]!.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
    await client.send(
      new ReceiveMessageCommand({ QueueUrl: source, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
    );
    const dead = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: deadLetter,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
      }),
    );
    assert.equal(dead.Messages?.[0]?.Body, body);
    assert.ok(dead.Messages?.[0]?.ReceiptHandle);
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: deadLetter,
        ReceiptHandle: dead.Messages[0]!.ReceiptHandle,
      }),
    );
    console.log('Poison message redrive to dead-letter queue passed');
  } catch (error) {
    failure = error;
  } finally {
    const failed: string[] = [];
    for (const url of [...created].reverse()) {
      try {
        await client.send(new DeleteQueueCommand({ QueueUrl: url }));
      } catch {
        failed.push(url);
      }
    }
    if (failed.length) {
      console.error(
        `Failed to delete ${failed.length} test queues; see ${manifest} for the recorded URLs`,
      );
      process.exitCode = 1;
    } else if (created.length) {
      await unlink(manifest);
      console.log(`Deleted ${created.length} temporary test queues`);
    }
    client.destroy();
  }
  if (failure) throw failure;
}
void main().catch((error: unknown) => {
  console.error(
    'AWS SQS P13 test failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
