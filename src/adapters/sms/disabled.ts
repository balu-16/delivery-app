import type {
  SmsMessageResult,
  SmsPort,
} from '../../modules/notifications/contracts/notifications.js';

/**
 * SMS is an explicitly disabled capability (source Section 2.4): the adapter
 * throws FEATURE_DISABLED and never breaks other channels. The notification
 * pipeline never routes to SMS; the port exists for future use only.
 */
export class DisabledSms implements SmsPort {
  async send(
    _to: string,
    _template: string,
    _data: Record<string, string>,
  ): Promise<SmsMessageResult> {
    throw new Error('FEATURE_DISABLED');
  }
}
