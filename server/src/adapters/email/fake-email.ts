import type {
  EmailMessage,
  EmailPort,
  EmailSendResult,
} from '../../modules/notifications/contracts/notifications.js';

export interface RecordedEmail {
  to: string;
  subject: string;
  body: string;
  messageId: string;
}

/** In-memory fake for tests/local: scripted failures then success. */
export class FakeEmail implements EmailPort {
  readonly sent: RecordedEmail[] = [];
  /** Number of upcoming sends that fail before succeeding again. */
  failNext = 0;
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('ExternalServiceUnavailable');
    }
    const messageId = `fake-email-${this.sent.length + 1}`;
    this.sent.push({ ...message, messageId });
    return { messageId };
  }
  toAddresses(): string[] {
    return this.sent.map((entry) => entry.to);
  }
}
