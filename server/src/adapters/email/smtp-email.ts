import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type {
  EmailMessage,
  EmailPort,
  EmailSendResult,
} from '../../modules/notifications/contracts/notifications.js';
import { SendProviderError } from './provider-error.js';

const TIMEOUT_MS = 10_000;
const DEFAULT_FROM = 'no-reply@delivery.local';

/**
 * SMTP adapter (local default: Mailpit via SMTP_URL). One attempt per call
 * with connection/socket timeouts; the durable delivery row owns bounded
 * retries with jitter.
 */
export class SmtpEmail implements EmailPort {
  private readonly transport: Transporter;
  constructor(
    smtpUrl: string,
    private readonly from: string = DEFAULT_FROM,
    createTransport: (options: SMTPTransport.Options) => Transporter = nodemailer.createTransport,
  ) {
    this.transport = createTransport({
      url: smtpUrl,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
  }
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!message.to || !message.subject || !message.body) throw new Error('INVALID_INPUT');
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        messageId: message.messageId ? `<${message.messageId}@delivery.local>` : undefined,
        to: message.to,
        subject: message.subject,
        text: message.body,
      });
      return { messageId: info.messageId ?? null };
    } catch (error: unknown) {
      throw new SendProviderError('ExternalServiceUnavailable', error);
    }
  }
  async close(): Promise<void> {
    this.transport.close();
  }
}
