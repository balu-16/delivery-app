import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { S3PrivateUploads } from '../../../src/adapters/storage/s3-private.js';
import { S3Storage } from '../../../src/modules/media/infrastructure/s3-storage.js';
import { MediaOrphanCleanup } from '../../../src/modules/media/infrastructure/orphan-cleanup.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices, db: DatabaseHandle;
const rider = uuidV7(),
  other = uuidV7();
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl);
  for (const [id, sub] of [
    [rider, 's3-rider'],
    [other, 's3-other'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${sub},${sub + '@example.invalid'},${sub})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,'RIDER')`.execute(db.db);
    await sql`INSERT INTO rider_profiles(user_id,status) VALUES(${id}::uuid,'PENDING')`.execute(
      db.db,
    );
  }
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('promotes owner-bound KYC using the S3 SDK contract, signed reads, and durable cleanup', async () => {
  const client = new S3Client({
    region: 'ap-south-1',
    endpoint: 'http://127.0.0.1:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const calls: unknown[] = [];
  client.send = (async (command: unknown) => {
    calls.push(command);
    if (command instanceof HeadObjectCommand)
      return { ContentLength: 12, ContentType: 'image/png', ETag: '"source-etag"' };
    if (command instanceof GetObjectCommand)
      return {
        Body: { transformToByteArray: async () => Buffer.from('89504e470d0a1a0a00000000', 'hex') },
      };
    if (command instanceof CopyObjectCommand || command instanceof DeleteObjectCommand) return {};
    throw new Error('unexpected command');
  }) as typeof client.send;
  const adapter = new S3PrivateUploads(db.db, client, 'private-bucket', 1000, 300, 60);
  const target = await adapter.createTarget(rider, 'RIDER_KYC', 'image/png', 12);
  const policy = JSON.parse(Buffer.from(target.fields.Policy!, 'base64').toString()) as {
    conditions: unknown[];
  };
  expect(policy.conditions).toContainEqual(['content-length-range', 12, 12]);
  expect(policy.conditions).toContainEqual({ 'Content-Type': 'image/png' });
  expect(target.fields.key).toMatch(new RegExp(`^kyc/staging/${target.mediaId}/`));
  await expect(adapter.assertOwnedRegistered(other, target.mediaId, 'RIDER_KYC')).rejects.toThrow(
    'MEDIA_NOT_FOUND',
  );
  await adapter.assertOwnedRegistered(rider, target.mediaId, 'RIDER_KYC');
  const row = await sql<{
    state: string;
    file_key: string;
  }>`SELECT state,file_key FROM private_media WHERE id=${target.mediaId}::uuid`.execute(db.db);
  expect(row.rows[0]?.state).toBe('STORED');
  const copy = calls.find((c) => c instanceof CopyObjectCommand) as CopyObjectCommand;
  expect(copy.input).toMatchObject({
    Bucket: 'private-bucket',
    Key: `kyc/final/${row.rows[0]!.file_key}`,
    CopySource: `private-bucket/${target.fields.key}`,
    CopySourceIfMatch: '"source-etag"',
  });
  const signed = new URL(await adapter.signedRead(target.mediaId));
  expect(signed.pathname).toContain(`/kyc/final/${row.rows[0]!.file_key}`);
  expect(signed.searchParams.has('X-Amz-Signature')).toBe(true);
  const orphan = await sql<{
    object_key: string;
  }>`SELECT object_key FROM media_orphan_objects WHERE object_key=${target.fields.key}`.execute(
    db.db,
  );
  expect(orphan.rows).toHaveLength(1);
  await sql`UPDATE media_orphan_objects SET remove_after=clock_timestamp()-interval '1 second' WHERE object_key=${target.fields.key}`.execute(
    db.db,
  );
  await new MediaOrphanCleanup(
    db.db,
    new S3Storage(client, 'media-bucket', 'private-bucket'),
  ).runOne();
  expect(
    calls.some((c) => c instanceof DeleteObjectCommand && c.input.Key === target.fields.key),
  ).toBe(true);
  const kept = await sql<{
    state: string;
  }>`SELECT state FROM private_media WHERE id=${target.mediaId}::uuid`.execute(db.db);
  expect(kept.rows[0]?.state).toBe('STORED');
  client.destroy();
});
