import { ResilientIdentityAdmin } from '../../../src/adapters/auth/resilient.js';
import type { IdentityAdminPort } from '../../../src/modules/identity/contracts/identity.js';

test('provider breaker bounds repeated outages and recovers after the cooldown', async () => {
  let now = 0,
    calls = 0,
    healthy = false;
  const fail = async () => {
    calls++;
    if (!healthy) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  };
  const inner: IdentityAdminPort = {
    create: async () => ({ sub: 's' }),
    find: async () => null,
    addToGroup: fail,
    removeFromGroup: fail,
    enable: fail,
    delete: fail,
    disable: fail,
    forcePasswordReset: fail,
  };
  const provider = new ResilientIdentityAdmin(inner, 2, 1000, () => now);
  await expect(provider.disable('u')).rejects.toMatchObject({ code: 'ExternalServiceTimeout' });
  await expect(provider.disable('u')).rejects.toMatchObject({ code: 'ExternalServiceTimeout' });
  await expect(provider.disable('u')).rejects.toMatchObject({ code: 'ExternalServiceUnavailable' });
  expect(calls).toBe(2);
  now = 1000;
  healthy = true;
  await expect(provider.disable('u')).resolves.toBeUndefined();
  expect(calls).toBe(3);
});
