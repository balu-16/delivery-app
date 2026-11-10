import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type {
  EmailMessage,
  EmailPort,
  EmailSendResult,
} from '../../modules/notifications/contracts/notifications.js';
import { SendProviderError } from './provider-error.js';

const TIMEOUT_MS = 10_000;

/**
 * SES v2 adapter. One attempt per call with a hard abort timeout; the durable
 * delivery row owns bounded retries with jitter. No exactly-once claim: a
 * timeout after provider acceptance may still deliver.
 */
export class SesEmail implements EmailPort {
  private readonly client: Pick<SESv2Client, 'send'>;
  constructor(
    region: string,
    private readonly fromAddress: string,
    client?: Pick<SESv2Client, 'send'>,
  ) {
    this.client =
      client ??
      new SESv2Client({
        region,
        requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: TIMEOUT_MS },
      });
  }
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!message.to || !message.subject || !message.body) throw new Error('INVALID_INPUT');
    try {
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromAddress,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
            },
          },
        }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      return { messageId: result.MessageId ?? null };
    } catch (error: unknown) {
      throw new SendProviderError('ExternalServiceUnavailable', error);
    }
  }
}
