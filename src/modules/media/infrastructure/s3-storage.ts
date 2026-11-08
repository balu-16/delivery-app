import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { boundedBytes } from './stream-limit.js';
import type { StoragePort } from '../contracts/storage.js';
import { storageError } from '../../../common/security/storage-errors.js';
/** Staging keys are client-writable; final keys are only written by the server. */
export class S3Storage implements StoragePort {
  constructor(
    private readonly client: S3Client,
    private readonly mediaBucket: string,
    private readonly privateBucket: string,
  ) {}
  private bucket(key: string) {
    return key.startsWith('public/') ? this.mediaBucket : this.privateBucket;
  }
  async target(key: string, type: string, size: number, expires: number) {
    try {
      const result = await createPresignedPost(this.client, {
        Bucket: this.bucket(key),
        Key: key,
        Expires: expires,
        Fields: { 'Content-Type': type },
        Conditions: [['content-length-range', size, size], { 'Content-Type': type }],
      });
      return { url: result.url, fields: result.fields };
    } catch (error) {
      throw storageError(error);
    }
  }
  async inspect(key: string) {
    try {
      const h = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket(key), Key: key }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (h.ContentLength === undefined || !h.ContentType || !h.ETag)
        throw new Error('INVALID_MEDIA');
      return { size: h.ContentLength, type: h.ContentType, etag: h.ETag };
    } catch (error) {
      throw storageError(error);
    }
  }
  async promote(source: string, destination: string, etag: string) {
    try {
      const sourceBucket = this.bucket(source);
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket(destination),
          Key: destination,
          CopySource: `${encodeURIComponent(sourceBucket)}/${source.split('/').map(encodeURIComponent).join('/')}`,
          CopySourceIfMatch: etag,
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
    } catch (error) {
      throw storageError(error);
    }
  }
  async putPrivate(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!key.startsWith('private/')) throw new Error('INVALID_MEDIA');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.privateBucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
    } catch (error) {
      throw storageError(error);
    }
  }
  async remove(key: string) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(key), Key: key }), {
        abortSignal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw storageError(error);
    }
  }
  async putPrivateStream(
    key: string,
    body: Readable,
    contentType: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!key.startsWith('private/')) throw new Error('INVALID_MEDIA');
    const input = { Bucket: this.privateBucket, Key: key };
    const signal = options.signal ?? AbortSignal.timeout(900000);
    const created = await this.client.send(
      new CreateMultipartUploadCommand({ ...input, ContentType: contentType }),
      { abortSignal: signal },
    );
    if (!created.UploadId) throw new Error('INVALID_MEDIA');
    const upload = { ...input, UploadId: created.UploadId },
      parts: { ETag: string; PartNumber: number }[] = [];
    const limited = body.pipe(boundedBytes(options.maxBytes ?? 536870912));
    const forward = (error: Error) => limited.destroy(error);
    body.on('error', forward);
    const abort = () => {
      const error = new Error('EXPORT_CANCELLED');
      body.destroy(error);
      limited.destroy(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let buffer = Buffer.alloc(0);
    const sendPart = async (bytes: Buffer) => {
      const number = parts.length + 1;
      const result = await this.client.send(
        new UploadPartCommand({ ...upload, PartNumber: number, Body: bytes }),
        { abortSignal: signal },
      );
      if (!result.ETag) throw new Error('INVALID_MEDIA');
      parts.push({ ETag: result.ETag, PartNumber: number });
    };
    try {
      for await (const chunk of limited) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
        while (buffer.length >= 5242880) {
          await sendPart(buffer.subarray(0, 5242880));
          buffer = buffer.subarray(5242880);
        }
      }
      if (buffer.length || !parts.length) await sendPart(buffer);
      await this.client.send(
        new CompleteMultipartUploadCommand({
          ...upload,
          MultipartUpload: { Parts: parts },
          IfNoneMatch: '*',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      body.destroy();
      limited.destroy();
      await this.client
        .send(new AbortMultipartUploadCommand(upload), { abortSignal: AbortSignal.timeout(10000) })
        .catch(() => undefined);
      throw error;
    } finally {
      body.off('error', forward);
      signal.removeEventListener('abort', abort);
    }
  }
  async open(key: string): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket(key), Key: key }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (!result.Body) throw new Error('MEDIA_NOT_FOUND');
      return result.Body as Readable;
    } catch (error) {
      throw storageError(error);
    }
  }
  async signedRead(key: string, expires: number) {
    if (!key.startsWith('private/') || !Number.isInteger(expires) || expires < 1 || expires > 300)
      throw new Error('INVALID_MEDIA');
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket(key), Key: key }),
        { expiresIn: expires },
      );
    } catch (error) {
      throw storageError(error);
    }
  }
}
