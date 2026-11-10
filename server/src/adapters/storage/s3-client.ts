import { S3Client } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import type { ConfigService } from '../../config/config.service.js';

/** An explicit profile fails closed; otherwise use the normal AWS credential chain. */
export function createS3Client(config: ConfigService): S3Client {
  const profile = config.get('AWS_S3_PROFILE');
  const endpoint = config.get('S3_ENDPOINT');
  return new S3Client({
    region: config.get('AWS_REGION'),
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}
