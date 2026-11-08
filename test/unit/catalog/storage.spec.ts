import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3Storage } from '../../../src/modules/media/infrastructure/s3-storage.js';
import { validMediaMagic } from '../../../src/common/security/media-magic.js';

describe('S3 media adapter contract', () => {
  it('limits POST to the exact staging key, type and size and uses conditional cross-bucket copy', async () => {
    const client = new S3Client({
      region: 'ap-south-1',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const storage = new S3Storage(client, 'media-bucket', 'private-bucket');
    const target = await storage.target('staging/abc/def', 'image/png', 1234, 60);
    const policy = JSON.parse(Buffer.from(target.fields.Policy!, 'base64').toString()) as {
      conditions: unknown[];
    };
    expect(target.fields.key).toBe('staging/abc/def');
    expect(policy.conditions).toContainEqual(['content-length-range', 1234, 1234]);
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'image/png' });
    const calls: unknown[] = [];
    client.send = (async (command: unknown) => {
      calls.push(command);
      return {};
    }) as typeof client.send;
    await storage.promote('staging/abc/def', 'public/abc/final', '"etag"');
    const command = calls[0] as CopyObjectCommand;
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'media-bucket',
      Key: 'public/abc/final',
      CopySource: 'private-bucket/staging/abc/def',
      CopySourceIfMatch: '"etag"',
      IfNoneMatch: '*',
    });
    client.destroy();
  });
  it('maps missing keys and precondition failures to safe errors and rejects spoofed images', async () => {
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const calls: unknown[] = [];
    client.send = (async (command: unknown) => {
      calls.push(command);
      if (command instanceof HeadObjectCommand)
        throw Object.assign(new Error('sensitive provider detail'), { name: 'NotFound' });
      throw Object.assign(new Error('detail'), { $metadata: { httpStatusCode: 412 } });
    }) as typeof client.send;
    const storage = new S3Storage(client, 'public', 'private');
    await expect(storage.inspect('staging/a/b')).rejects.toThrow('MEDIA_NOT_FOUND');
    await expect(storage.promote('staging/a/b', 'public/a/c', '"e"')).rejects.toThrow(
      'INVALID_MEDIA',
    );
    expect(validMediaMagic('image/png', Buffer.from('not a png'))).toBe(false);
    expect(calls).toHaveLength(2);
    client.destroy();
  });
});
