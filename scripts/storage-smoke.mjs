import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3Storage } from '../dist/modules/media/infrastructure/s3-storage.js';

// Explicit, local-emulator-only check. Missing configuration fails instead of skipping.
const endpoint = new URL(process.env.TEST_S3_ENDPOINT ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname), 'Use a loopback emulator');
assert(['http:', 'https:'].includes(endpoint.protocol), 'Use an HTTP(S) emulator');
assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const client = new S3Client({
  region: 'us-east-1',
  endpoint: endpoint.toString(),
  forcePathStyle: true,
  credentials: { accessKeyId: 'local-contract', secretAccessKey: 'local-contract' },
});
const id = randomUUID();
const publicBucket = `delivery-public-${id}`;
const privateBucket = `delivery-private-${id}`;
const storage = new S3Storage(client, publicBucket, privateBucket);
const source = `staging/${id}/${randomUUID()}`;
const final = `public/${id}/${randomUUID()}`;
const bytes = Buffer.from('local storage contract fixture');
const buckets = [];

try {
  for (const bucket of [publicBucket, privateBucket]) {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    buckets.push(bucket);
  }
  const upload = await storage.target(source, 'image/png', bytes.length, 60);
  const policy = JSON.parse(Buffer.from(upload.fields.Policy, 'base64').toString('utf8'));
  assert(
    policy.conditions.some(
      (condition) =>
        Array.isArray(condition) &&
        condition[0] === 'content-length-range' &&
        condition[1] === bytes.length &&
        condition[2] === bytes.length,
    ),
  );
  assert(policy.conditions.some((condition) => condition['Content-Type'] === 'image/png'));
  const form = new globalThis.FormData();
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  form.append('file', new globalThis.Blob([bytes], { type: 'image/png' }), 'fixture.png');
  const uploaded = await globalThis.fetch(upload.url, { method: 'POST', body: form });
  assert(uploaded.ok, `Presigned upload returned ${uploaded.status}`);
  const meta = await storage.inspect(source);
  assert.equal(meta.size, bytes.length);
  assert.equal(meta.type, 'image/png');
  await storage.promote(source, final, meta.etag);
  await client.send(
    new PutObjectCommand({
      Bucket: privateBucket,
      Key: source,
      Body: Buffer.from('replacement staging content'),
      ContentType: 'image/png',
    }),
  );
  const chunks = [];
  for await (const chunk of await storage.open(final)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const downloaded = await globalThis.fetch(await storage.signedRead(final, 60));
  assert(downloaded.ok);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  process.stdout.write(
    'S3 emulator contract passed: constrained POST, HEAD, promotion, staging overwrite isolation and signed GET\n',
  );
} finally {
  try {
    await storage.remove(source);
    await storage.remove(final);
    for (const bucket of buckets) await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}
