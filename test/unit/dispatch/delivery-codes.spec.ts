import {
  assertDeliveryCodeShape,
  deriveCode,
  deriveVerifier,
  verifiersMatch,
} from '../../../src/modules/orders/infrastructure/code-crypto.js';
import { DispatchSettings } from '../../../src/modules/dispatch/infrastructure/settings.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';

const SECRET = 'unit-test-delivery-code-secret';
const ORDER = '018f0000-0000-7000-8000-000000000001';

describe('delivery code derivation (D20)', () => {
  test('codes are deterministic, 4 digits, and order-specific', () => {
    const first = deriveCode(SECRET, ORDER);
    expect(first).toMatch(/^\d{4}$/);
    expect(deriveCode(SECRET, ORDER)).toBe(first);
    expect(deriveCode(SECRET, '018f0000-0000-7000-8000-000000000002')).not.toBe(first);
  });

  test('key versions rotate the code without reusing derivations', () => {
    expect(deriveCode(SECRET, ORDER, 2)).not.toBe(deriveCode(SECRET, ORDER, 1));
    expect(deriveCode(SECRET, ORDER, 2)).toBe(deriveCode(SECRET, ORDER, 2));
  });

  test('the stored verifier never reveals the code and verifies exactly', () => {
    const code = deriveCode(SECRET, ORDER);
    const verifier = deriveVerifier(SECRET, ORDER, code);
    expect(verifier.toString('hex')).not.toBe(code);
    expect(verifier).toHaveLength(32);
    expect(verifiersMatch(verifier, deriveVerifier(SECRET, ORDER, code))).toBe(true);
    expect(verifiersMatch(verifier, deriveVerifier(SECRET, ORDER, '0000'))).toBe(code === '0000');
    for (let i = 0; i < 10000; i += 997) {
      const candidate = String(i).padStart(4, '0');
      if (candidate !== code)
        expect(verifiersMatch(verifier, deriveVerifier(SECRET, ORDER, candidate))).toBe(false);
    }
  });

  test('verifier keys are separated from derivation keys', () => {
    // The verifier of the code is not derivable from the code key ring alone.
    const code = deriveCode(SECRET, ORDER);
    expect(deriveVerifier(SECRET, ORDER, code)).not.toBe(code);
    expect(deriveCode(SECRET, ORDER)).toHaveLength(4);
  });

  test('code shape is enforced before verification', () => {
    expect(() => assertDeliveryCodeShape('123')).toThrow('DELIVERY_CODE_INVALID');
    expect(() => assertDeliveryCodeShape('12345')).toThrow('DELIVERY_CODE_INVALID');
    expect(() => assertDeliveryCodeShape('12a4')).toThrow('DELIVERY_CODE_INVALID');
    expect(() => assertDeliveryCodeShape('0000')).not.toThrow();
  });

  test('settings propagate unavailable configuration instead of silently using local defaults', async () => {
    const config: AppConfig = {
      get: async () => {
        throw new Error('UNKNOWN_CONFIG_KEY');
      },
    };
    const settings = new DispatchSettings(config);
    await expect(settings.number('deliveryCodeMaxAttempts')).rejects.toThrow('UNKNOWN_CONFIG_KEY');
    await expect(settings.number('offerTimeoutSeconds')).rejects.toThrow('UNKNOWN_CONFIG_KEY');
    await expect(settings.paise('cashInHandLimitPaise')).rejects.toThrow('UNKNOWN_CONFIG_KEY');
    await expect(settings.trigger()).rejects.toThrow('UNKNOWN_CONFIG_KEY');
    await expect(settings.wideningSteps()).rejects.toThrow('UNKNOWN_CONFIG_KEY');
  });
});
