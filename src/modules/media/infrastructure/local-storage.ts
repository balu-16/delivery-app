import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import type { StoragePort } from '../contracts/storage.js';
import { storageError } from '../../../common/security/storage-errors.js';
/** Development adapter: a capability authorizes one immutable staging write. */
export class LocalStorage implements StoragePort {
  private readonly key: Uint8Array;
  constructor(
    private readonly directory: string,
    secret: string,
  ) {
    this.key = createHmac('sha256', secret).update('delivery:catalog-storage:v1').digest();
  }
  private path(key: string) {
    if (!/^(staging|public|private)\/[a-f0-9/-]+$/.test(key)) throw new Error('INVALID_MEDIA');
    return resolve(this.directory, key);
  }
  async target(key: string, type: string, size: number, expires: number) {
    const token = await new SignJWT({ key, type, size })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${expires}s`)
      .setAudience('catalog-upload')
      .sign(this.key);
    return {
      url: `/dev/catalog-media/${key.split('/')[1]}`,
      fields: { authorization: `Bearer ${token}` },
    };
  }
  async upload(id: string, token: string, body: Buffer) {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ['HS256'],
      audience: 'catalog-upload',
    });
    if (
      typeof payload.key !== 'string' ||
      !payload.key.startsWith(`staging/${id}/`) ||
      typeof payload.type !== 'string' ||
      payload.size !== body.length
    )
      throw new Error('INVALID_MEDIA');
    const path = this.path(payload.key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(body);
      await writeFile(`${path}.type`, payload.type, { flag: 'wx', mode: 0o600 });
    } finally {
      await file.close();
    }
  }
  async inspect(key: string) {
    try {
      const path = this.path(key),
        bytes = await readFile(path),
        type = await readFile(`${path}.type`, 'utf8');
      return { size: bytes.length, type, etag: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      throw storageError(error);
    }
  }
  async promote(source: string, destination: string, etag: string) {
    const bytes = await readFile(this.path(source));
    if (createHash('sha256').update(bytes).digest('hex') !== etag) throw new Error('INVALID_MEDIA');
    const type = await readFile(`${this.path(source)}.type`, 'utf8'),
      dest = this.path(destination);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(`${dest}.type`, type, { flag: 'wx', mode: 0o600 });
  }
  async putPrivate(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!key.startsWith('private/')) throw new Error('INVALID_MEDIA');
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, body, { flag: 'wx', mode: 0o600 });
      await writeFile(`${path}.type`, contentType, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw storageError(error);
    }
  }
  async remove(key: string) {
    const remove = async (path: string) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw storageError(error);
      }
    };
    await Promise.all([remove(this.path(key)), remove(`${this.path(key)}.type`)]);
  }
  async open(key: string) {
    try {
      const path = this.path(key);
      await stat(path);
      return createReadStream(path);
    } catch (error) {
      throw storageError(error);
    }
  }
}
