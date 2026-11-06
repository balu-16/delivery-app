import type { CallMaskingPort } from '../../modules/serviceability/contracts/contact.js';
export class DisabledCallMasking implements CallMaskingPort {
  async createCall(_fromUserId: string, _toUserId: string): Promise<{ callId: string }> {
    throw new Error('FEATURE_DISABLED');
  }
}
