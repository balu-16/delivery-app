import { createS3Client } from '../../../src/adapters/storage/s3-client.js';
import { ConfigService } from '../../../src/config/config.service.js';
import { readEnv } from '../../../src/config/env.schema.js';

test('AWS S3 resolves the configured region when no custom endpoint is set', async () => {
  const client = createS3Client(new ConfigService(readEnv({ AWS_REGION: 'ap-southeast-2' })));
  expect(await client.config.region()).toBe('ap-southeast-2');
  expect(client.config.endpoint).toBeUndefined();
  expect(client.config.forcePathStyle).toBe(false);
  client.destroy();
});

test('a custom S3-compatible endpoint enables path-style URLs', async () => {
  const client = createS3Client(
    new ConfigService(readEnv({ S3_ENDPOINT: 'http://127.0.0.1:4566' })),
  );
  expect((await client.config.endpoint!()).hostname).toBe('127.0.0.1');
  expect(client.config.forcePathStyle).toBe(true);
  client.destroy();
});
