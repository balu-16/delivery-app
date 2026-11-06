import {
  ServiceabilityQuery,
  type Candidate,
} from '../../../src/modules/serviceability/application/serviceability.js';
import { Addresses } from '../../../src/modules/addresses/application/addresses.js';
import { FakeMaps } from '../../../src/adapters/maps/fake.js';
import type { AddressRepository } from '../../../src/modules/addresses/contracts/addresses.js';

const zone = { zoneId: 'zone', zoneVersion: '1', cityZoneVersion: '2', storeId: 'store' };
const available: Candidate = {
  zone,
  status: 'ONLINE',
  open: true,
  capacityRemaining: true,
  noRidersAvailable: false,
};
const input = { lat: 13, lng: 77.6, targetTime: new Date('2026-11-02T12:00:00Z') };
const eta = async () => ({ minMinutes: 10, maxMinutes: 30 });
describe('serviceability application decisions', () => {
  it('returns the matching snapshot and configured estimate when all checks pass', async () => {
    const query = new ServiceabilityQuery({ findCandidate: async () => available }, eta);
    expect(await query.check(input)).toEqual({
      serviceable: true,
      storeId: 'store',
      zone,
      etaRange: { minMinutes: 10, maxMinutes: 30 },
      reasons: [],
    });
  });
  it('reports outside zones and all applicable store availability reasons', async () => {
    const outside = new ServiceabilityQuery({ findCandidate: async () => null }, eta);
    expect(await outside.check(input)).toMatchObject({
      serviceable: false,
      storeId: null,
      reasons: ['OUTSIDE_ZONE'],
    });
    const blocked = new ServiceabilityQuery(
      {
        findCandidate: async () => ({
          ...available,
          status: 'PAUSED',
          open: false,
          capacityRemaining: false,
          noRidersAvailable: true,
        }),
      },
      eta,
    );
    expect(await blocked.check(input)).toMatchObject({
      serviceable: false,
      etaRange: null,
      reasons: ['STORE_PAUSED', 'STORE_CLOSED', 'STORE_AT_CAPACITY', 'NO_RIDERS_AVAILABLE'],
    });
    const offline = new ServiceabilityQuery(
      { findCandidate: async () => ({ ...available, status: 'OFFLINE' }) },
      eta,
    );
    expect((await offline.check(input)).reasons).toContain('STORE_CLOSED');
  });
  it('rejects invalid pin, target instant and inconsistent ETA policy', async () => {
    const query = new ServiceabilityQuery({ findCandidate: async () => available }, eta);
    await expect(query.check({ ...input, lat: 0 })).rejects.toThrow('INVALID_COORDINATES');
    await expect(query.check({ ...input, targetTime: new Date('invalid') })).rejects.toThrow(
      'INVALID_TARGET_TIME',
    );
    const bad = new ServiceabilityQuery({ findCandidate: async () => available }, async () => ({
      minMinutes: 60,
      maxMinutes: 20,
    }));
    await expect(bad.check(input)).rejects.toThrow('INVALID_ETA_CONFIG');
  });
});

describe('address application ownership and version delegation', () => {
  it('preserves owner and version on update, default, list and removal', async () => {
    const calls: unknown[][] = [];
    const draft = {
      line1: 'Road',
      pincode: '560001',
      contactName: 'A',
      contactPhone: '+919876543210',
      point: { lat: 13, lng: 77.6 },
    };
    const value = { ...draft, id: 'a', isDefault: true, version: '2' };
    const repository: AddressRepository = {
      list: async (...args) => {
        calls.push(['list', ...args]);
        return [value];
      },
      create: async () => value,
      update: async (...args) => {
        calls.push(['update', ...args]);
        return value;
      },
      setDefault: async (...args) => {
        calls.push(['default', ...args]);
      },
      remove: async (...args) => {
        calls.push(['remove', ...args]);
      },
    };
    const addresses = new Addresses(
      repository,
      async () => 10,
      new FakeMaps([], 20),
      async () => 100,
    );
    await addresses.list('owner');
    expect(await addresses.update('owner', 'a', draft, '1')).toMatchObject({
      address: value,
      degraded: true,
    });
    await addresses.setDefault('owner', 'a');
    await addresses.remove('owner', 'a');
    await expect(addresses.update('owner', 'a', draft, '0')).rejects.toThrow('INVALID_VERSION');
    expect(calls).toEqual([
      ['list', 'owner'],
      ['update', 'owner', 'a', draft, '1'],
      ['default', 'owner', 'a'],
      ['remove', 'owner', 'a'],
    ]);
  });
});

describe('delivery contact privacy contract', () => {
  it('only permits the assigned rider during the active task window', async () => {
    const { canViewDeliveryContact } =
      await import('../../../src/modules/serviceability/contracts/contact.js');
    expect(
      canViewDeliveryContact({
        requestingRiderId: 'r1',
        assignedRiderId: 'r1',
        taskStatus: 'ARRIVED',
      }),
    ).toBe(true);
    for (const context of [
      { requestingRiderId: 'r2', assignedRiderId: 'r1', taskStatus: 'ARRIVED' },
      { requestingRiderId: 'r1', assignedRiderId: 'r1', taskStatus: 'DELIVERED' },
      { requestingRiderId: 'r1', assignedRiderId: null, taskStatus: 'ASSIGNED' },
    ])
      expect(canViewDeliveryContact(context)).toBe(false);
  });
});
