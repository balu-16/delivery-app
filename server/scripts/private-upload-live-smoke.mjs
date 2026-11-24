#!/usr/bin/env node
// Run from server/ against the configured Sydney development resources.
// AWS_PROFILE=default AWS_P13_INTEGRATION=yes AWS_P13_PRIVATE_UPLOAD_SMOKE=yes \
//   node --env-file=.env --import tsx scripts/private-upload-live-smoke.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase } from '../src/platform/database/database.js';
import { S3PrivateUploads } from '../src/adapters/storage/s3-private.js';
import { createS3Client } from '../src/adapters/storage/s3-client.js';
import { uuidV7 } from '../src/common/ids/ids.js';
import { readEnv } from '../src/config/env.schema.js';
import { ConfigService } from '../src/config/config.service.js';
import { startTestServices } from '../test/helpers/services.js';

const fixtures = [
  {
    mime: 'application/pdf',
    name: 'sample.pdf',
    bytes: Buffer.from('%PDF-1.7\n% synthetic\n%%EOF\n'),
  },
  {
    mime: 'image/png',
    name: 'sample.png',
    bytes: Buffer.from('89504e470d0a1a0a0000000000000000', 'hex'),
  },
];

async function main() {
  assert(
    process.env.AWS_P13_PRIVATE_UPLOAD_SMOKE === 'yes' && process.env.AWS_P13_INTEGRATION === 'yes',
    'OPT_IN_REQUIRED',
  );
  const env = readEnv(process.env);
  assert(
    env.NODE_ENV === 'development' && env.STORAGE_PROVIDER === 's3' && !env.S3_ENDPOINT,
    'DEVELOPMENT_S3_REQUIRED',
  );
  assert(
    env.AWS_REGION === 'ap-southeast-2' && env.S3_PRIVATE_BUCKET,
    'SYDNEY_PRIVATE_BUCKET_REQUIRED',
  );
  const s3 = createS3Client(new ConfigService(env));
  let services;
  let db;
  let inventoryIncomplete = false;
  const keys = new Set();
  const manifest = `artifacts/private-upload-${randomUUID()}-cleanup.json`;
  const saveManifest = () =>
    writeFile(
      manifest,
      JSON.stringify({
        region: env.AWS_REGION,
        bucket: env.S3_PRIVATE_BUCKET,
        objectKeys: [...keys],
        database: services?.databaseIamUrl
          ? new URL(services.databaseIamUrl).pathname.slice(1)
          : undefined,
      }),
      { mode: 0o600 },
    );
  const collectObjectKeys = async () => {
    if (!db) return;
    inventoryIncomplete = true;
    try {
      const objects = await sql`SELECT object_key FROM media_orphan_objects
        UNION SELECT object_key FROM private_media_promotions`.execute(db.db);
      for (const { object_key } of objects.rows) keys.add(object_key);
      inventoryIncomplete = false;
    } catch (error) {
      throw new Error('CLEANUP_INVENTORY_PENDING', { cause: error });
    }
  };

  try {
    await mkdir('artifacts', { recursive: true });
    services = await startTestServices({ skipAwsCache: true });
    assert(
      services.databaseIamUrl &&
        /^\/delivery_p13_[0-9a-f]{32}$/.test(new URL(services.databaseIamUrl).pathname),
      'ISOLATED_DATABASE_REQUIRED',
    );
    await runner({
      databaseUrl: services.databaseUrl,
      dir: 'db/migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    db = createDatabase(services.databaseIamUrl, 4, 30000, undefined, 30000, env.AWS_REGION);
    const adapter = new S3PrivateUploads(
      db.db,
      s3,
      env.S3_PRIVATE_BUCKET,
      env.PRIVATE_UPLOAD_MAX_BYTES,
      env.PRIVATE_UPLOAD_URL_TTL_SECONDS,
      env.PRIVATE_READ_URL_TTL_SECONDS,
    );
    const rider = uuidV7(),
      other = uuidV7();
    for (const id of [rider, other]) {
      await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name)
        VALUES(${id}::uuid,'WORKFORCE',${id},${`${id}@test.invalid`},'Synthetic rider')`.execute(
        db.db,
      );
      await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,'RIDER')`.execute(db.db);
      await sql`INSERT INTO rider_profiles(user_id,status) VALUES(${id}::uuid,'PENDING')`.execute(
        db.db,
      );
    }

    for (const { mime, name, bytes } of fixtures) {
      const target = await adapter.createTarget(rider, 'RIDER_KYC', mime, bytes.length);
      keys.add(target.fields.key);
      await saveManifest();
      console.log(`target ready for ${mime}`);
      await assert.rejects(adapter.prepareOwnedUpload(rider, target.mediaId, 'RIDER_KYC'), {
        message: 'UPLOAD_NOT_RECEIVED',
      });
      const body = new globalThis.FormData();
      for (const [field, value] of Object.entries(target.fields)) body.append(field, value);
      body.append('file', new globalThis.Blob([bytes], { type: mime }), name);
      const sent = await fetch(target.url, {
        method: 'POST',
        body,
        signal: globalThis.AbortSignal.timeout(30000),
      });
      assert(sent.ok, `TRANSFER_HTTP_${sent.status}`);
      console.log(`transfer accepted for ${mime}`);
      await assert.rejects(adapter.prepareOwnedUpload(other, target.mediaId, 'RIDER_KYC'), {
        message: 'MEDIA_NOT_FOUND',
      });
      const prepared = await adapter.prepareOwnedUpload(rider, target.mediaId, 'RIDER_KYC');
      const promotion =
        await sql`SELECT object_key FROM private_media_promotions WHERE media_id=${target.mediaId}::uuid`.execute(
          db.db,
        );
      for (const { object_key } of promotion.rows) keys.add(object_key);
      await saveManifest();
      await assert.rejects(adapter.prepareOwnedUpload(rider, target.mediaId, 'RIDER_KYC'), {
        message: 'UPLOAD_PROCESSING',
      });
      await db.db.transaction().execute(prepared.commit);
      const readUrl = await adapter.signedRead(target.mediaId);
      const read = await fetch(readUrl, { signal: globalThis.AbortSignal.timeout(30000) });
      assert(read.ok, `READ_HTTP_${read.status}`);
      assert(Buffer.from(await read.arrayBuffer()).equals(bytes), 'SIGNED_READ_BYTES_DIFFER');
      console.log(`confirmation and signed read passed for ${mime}`);
    }
  } finally {
    try {
      await collectObjectKeys();
      if (keys.size) {
        await saveManifest();
        for (const key of keys) {
          assert(
            /^kyc\/(?:staging\/[0-9a-f-]{36}\/[0-9a-f-]{36}|final\/[0-9a-f-]{36})$/i.test(key),
            'UNEXPECTED_OBJECT_KEY',
          );
          await s3.send(new DeleteObjectCommand({ Bucket: env.S3_PRIVATE_BUCKET, Key: key }), {
            abortSignal: globalThis.AbortSignal.timeout(10000),
          });
        }
        await unlink(manifest);
        console.log(`cleaned ${keys.size} synthetic objects`);
      }
    } finally {
      s3.destroy();
      await db?.close();
      if (!inventoryIncomplete) await services?.stop();
    }
  }
}

main().catch((error) => {
  const code = /^(?:[A-Z_]+|(?:TRANSFER|READ)_HTTP_\d{3})$/.test(error?.message ?? '')
    ? error.message
    : 'PRIVATE_UPLOAD_SMOKE_FAILED';
  console.error(code);
  process.exitCode = 1;
});
