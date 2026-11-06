import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
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
