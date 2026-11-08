import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { LocalStorage } from '../../../src/modules/media/infrastructure/local-storage.js';
import { S3Storage } from '../../../src/modules/media/infrastructure/s3-storage.js';

it('streams immutable local private objects and verifies scoped download capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-export-test-'));
  try {
    const storage = new LocalStorage(directory, 'local-test-secret');
    await storage.putPrivateStream('private/abc/def', Readable.from(['one', 'two']), 'text/csv', {
      maxBytes: 6,
    });
    const url = await storage.signedRead('private/abc/def', 60);
    const capability = new URL(url, 'http://localhost').searchParams.get('capability')!;
    const object = await storage.readCapability(capability);
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('onetwo');
    expect(object.contentType).toBe('text/csv');
    await expect(
      storage.putPrivateStream('private/abc/def', Readable.from(['overwrite']), 'text/csv'),
    ).rejects.toThrow();
    await expect(storage.readCapability(capability + 'x')).rejects.toThrow();
    await expect(storage.signedRead('public/abc/def', 60)).rejects.toThrow('INVALID_MEDIA');
    await expect(
      storage.putPrivateStream('private/abc/aaa', Readable.from(['oversize']), 'text/csv', {
        maxBytes: 2,
      }),
    ).rejects.toThrow('EXPORT_SIZE_LIMIT');
    expect((await readdir(join(directory, 'private/abc'))).sort()).toEqual(['def', 'def.type']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('uploads bounded multipart data in order and aborts failed writes without completing them', async () => {
  const client = new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const calls: unknown[] = [];
  client.send = (async (command: unknown) => {
    calls.push(command);
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload' };
    if (command instanceof UploadPartCommand) return { ETag: 'part-' + command.input.PartNumber };
    return {};
  }) as typeof client.send;
  try {
    const storage = new S3Storage(client, 'public', 'private');
    await storage.putPrivateStream(
      'private/abc/def',
      Readable.from([Buffer.alloc(6 * 1024 * 1024)]),
      'text/csv',
    );
    const parts = calls.filter((c): c is UploadPartCommand => c instanceof UploadPartCommand);
    expect(parts.map((p) => (p.input.Body as Buffer).length)).toEqual([5242880, 1048576]);
    const complete = calls.find(
      (c): c is CompleteMultipartUploadCommand => c instanceof CompleteMultipartUploadCommand,
    )!;
    expect(complete.input).toMatchObject({
      Bucket: 'private',
      IfNoneMatch: '*',
      MultipartUpload: {
        Parts: [
          { ETag: 'part-1', PartNumber: 1 },
          { ETag: 'part-2', PartNumber: 2 },
        ],
      },
    });
    calls.length = 0;
    await expect(
      storage.putPrivateStream('private/abc/aaa', Readable.from(['too long']), 'text/csv', {
        maxBytes: 2,
      }),
    ).rejects.toThrow('EXPORT_SIZE_LIMIT');
    expect(calls.some((c) => c instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(calls.some((c) => c instanceof CompleteMultipartUploadCommand)).toBe(false);
  } finally {
    client.destroy();
  }
});
