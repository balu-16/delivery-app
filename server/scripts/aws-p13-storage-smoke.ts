import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from '../src/modules/media/infrastructure/s3-storage.js';

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.AWS_P13_STORAGE_SMOKE !== 'yes')
    throw new Error('AWS_P13_STORAGE_SMOKE=yes in development is required');
  const region = process.env.AWS_REGION;
  const media = process.env.S3_MEDIA_BUCKET;
  const privateBucket = process.env.S3_PRIVATE_BUCKET;
  const profile = process.env.AWS_S3_PROFILE;
  if (!region || !media || !privateBucket || media === privateBucket)
    throw new Error('Invalid S3 configuration');
  const client = new S3Client({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });
  const storage = new S3Storage(client, media, privateBucket);
  const id = randomUUID();
  const source = `staging/p13-${id}/${randomUUID()}`;
  const final = `public/p13-${id}/${randomUUID()}`;
  const privateKey = `private/p13-${id}/${randomUUID()}`;
  const bytes = Buffer.from('p13 storage fixture');
  let failure: unknown;
  try {
    const upload = await storage.target(source, 'image/png', bytes.length, 60);
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'fixture.png');
    const response = await fetch(upload.url, { method: 'POST', body: form });
    assert.equal(response.ok, true, `Signed upload returned ${response.status}`);
    console.log('S3 signed upload passed');
    const meta = await storage.inspect(source);
    assert.equal(meta.size, bytes.length);
    assert.equal(meta.type, 'image/png');
    console.log('S3 metadata inspection passed');
    await storage.promote(source, final, meta.etag);
    console.log('S3 conditional promotion passed');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.open(final)) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    console.log('S3 public object read passed');
    await storage.putPrivate(privateKey, bytes, 'text/plain');
    console.log('S3 private write passed');
    const privateDownload = await fetch(await storage.signedRead(privateKey, 60));
    assert.equal(
      privateDownload.ok,
      true,
      `Signed private read returned ${privateDownload.status}`,
    );
    assert.deepEqual(Buffer.from(await privateDownload.arrayBuffer()), bytes);
    console.log(
      'S3 signed upload, conditional promotion, public read and private signed read passed',
    );
  } catch (error) {
    failure = error;
  } finally {
    const results = await Promise.allSettled(
      [source, final, privateKey].map((key) => storage.remove(key)),
    );
    client.destroy();
    if (results.some((result) => result.status === 'rejected')) {
      console.error(`S3 cleanup failed for test prefix p13-${id}`);
      process.exitCode = 1;
    } else console.log('S3 test objects removed');
  }
  if (failure) throw failure;
}
void main().catch((error: unknown) => {
  console.error('S3 P13 smoke failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
