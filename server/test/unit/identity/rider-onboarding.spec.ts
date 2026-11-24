import { jest } from '@jest/globals';
import { projectRiderApplication } from '../../../src/modules/identity/contracts/rider-applications.js';
import { effectiveRequiredDocuments } from '../../../src/modules/identity/infrastructure/rider-application-reader.js';
import { normalizeVehicle } from '../../../src/modules/identity/infrastructure/rider-profile.js';
import { RiderOnboarding } from '../../../src/modules/identity/infrastructure/rider-onboarding.js';
import { RiderOnboardingSupport } from '../../../src/surfaces/rider/identity/rider-onboarding-support.service.js';
import type { Database } from '../../../src/platform/database/database.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import type { Support } from '../../../src/modules/support/contracts/support.js';

test('projection keeps rider-facing fields and the current document per type', () => {
  const projected = projectRiderApplication({
    userId: 'u1',
    name: 'Secret Name',
    email: 'rider@example.test',
    phone: null,
    appliedAt: '2026-11-20T00:00:00.000Z',
    status: 'UNDER_REVIEW',
    vehicleType: 'bike',
    vehicleNo: 'KA01ABC',
    homeStoreId: 's1',
    homeStore: { id: 's1', name: 'Store', city: 'City' },
    requiredDocuments: ['licence'],
    documents: [
      {
        id: 'd1',
        type: 'licence',
        status: 'PENDING',
        reason: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  });
  expect(projected).toEqual({
    userId: 'u1',
    status: 'UNDER_REVIEW',
    vehicleType: 'bike',
    vehicleNo: 'KA01ABC',
    homeStoreId: 's1',
    homeStore: { id: 's1', name: 'Store', city: 'City' },
    requiredDocuments: ['licence'],
    documents: [
      {
        id: 'd1',
        type: 'licence',
        status: 'PENDING',
        reason: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  });
  expect((projected as unknown as Record<string, unknown>).name).toBeUndefined();
  expect((projected as unknown as Record<string, unknown>).email).toBeUndefined();
});

test('projection carries the snapshot checklist through the rider boundary', () => {
  const snapshot = ['licence', 'vehicle_rc'];
  const projected = projectRiderApplication({
    userId: 'u1',
    name: 'Secret Name',
    email: 'rider@example.test',
    phone: null,
    appliedAt: '2026-11-20T00:00:00.000Z',
    status: 'UNDER_REVIEW',
    vehicleType: 'bike',
    vehicleNo: 'KA01ABC',
    homeStoreId: 's1',
    homeStore: { id: 's1', name: 'Store', city: 'City' },
    requiredDocuments: snapshot,
    documents: [
      {
        id: 'd1',
        type: 'licence',
        status: 'APPROVED',
        reason: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
      {
        id: 'd2',
        type: 'vehicle_rc',
        status: 'PENDING',
        reason: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  });
  expect(projected.requiredDocuments).toEqual(['licence', 'vehicle_rc']);
  expect(projected.documents.map((doc) => doc.type)).toEqual(['licence', 'vehicle_rc']);
});

test('under-review and approved applications read the snapshot, editable ones read live config', () => {
  const snapshot = ['licence', 'vehicle_rc', 'id_proof'];
  const live = ['licence', 'vehicle_rc', 'id_proof', 'bank_proof'];
  // Snapshot wins mid-review, so a config change cannot move the checklist.
  expect(effectiveRequiredDocuments('UNDER_REVIEW', snapshot, live)).toEqual(snapshot);
  expect(effectiveRequiredDocuments('APPROVED', snapshot, live)).toEqual(snapshot);
  // Editable applications always use the current requirements.
  expect(effectiveRequiredDocuments('PENDING', snapshot, live)).toEqual(live);
  expect(effectiveRequiredDocuments('REJECTED', snapshot, live)).toEqual(live);
  expect(effectiveRequiredDocuments('SUSPENDED', snapshot, live)).toEqual(live);
});

test('rows without a snapshot fall back to live config', () => {
  const live = ['licence', 'vehicle_rc', 'id_proof', 'bank_proof'];
  expect(effectiveRequiredDocuments('UNDER_REVIEW', null, live)).toEqual(live);
  expect(effectiveRequiredDocuments('APPROVED', null, live)).toEqual(live);
  expect(effectiveRequiredDocuments('UNDER_REVIEW', [], live)).toEqual(live);
});

test('the effective checklist is a copy, never the stored snapshot', () => {
  const snapshot = ['licence'];
  const live = ['licence', 'vehicle_rc'];
  const effective = effectiveRequiredDocuments('UNDER_REVIEW', snapshot, live);
  expect(effective).toEqual(['licence']);
  expect(effective).not.toBe(snapshot);
  effective.push('mutated');
  expect(snapshot).toEqual(['licence']);
  const fallback = effectiveRequiredDocuments('PENDING', snapshot, live);
  expect(fallback).not.toBe(live);
  fallback.push('mutated');
  expect(live).toEqual(['licence', 'vehicle_rc']);
});

test('vehicle normalization trims fields and uppercases registration', () => {
  expect(normalizeVehicle('  bike ', ' ka01abc ')).toEqual({
    vehicleType: 'bike',
    vehicleNo: 'KA01ABC',
  });
});

test('vehicle normalization rejects an empty type and empty registration separately', () => {
  expect(() => normalizeVehicle('   ', 'KA01ABC')).toThrow('INVALID_RIDER_PROFILE');
  expect(() => normalizeVehicle('bike', '   ')).toThrow('INVALID_RIDER_PROFILE');
});

test('vehicle normalization rejects each field over 40 characters', () => {
  expect(() => normalizeVehicle('x'.repeat(41), 'KA01ABC')).toThrow('INVALID_RIDER_PROFILE');
  expect(() => normalizeVehicle('bike', 'x'.repeat(41))).toThrow('INVALID_RIDER_PROFILE');
  expect(normalizeVehicle('x'.repeat(40), 'y'.repeat(40))).toEqual({
    vehicleType: 'x'.repeat(40),
    vehicleNo: 'Y'.repeat(40),
  });
});

test('upload targets preserve the storage capability expiration', async () => {
  const expiresAt = '2026-11-20T00:05:00.000Z';
  const uploads = {
    createTarget: async () => ({ mediaId: 'm1', url: 'u', fields: { k: 'v' }, expiresAt }),
    prepareOwnedUpload: async () => ({ commit: async () => {}, release: async () => {} }),
    assertOwnedRegistered: async () => undefined,
    signedRead: async () => '',
  };
  const onboarding = new RiderOnboarding({} as Database, uploads, {} as AppConfig);
  const target = await onboarding.uploadTarget('u1', 'image/png', 10);
  expect(target).toEqual({ mediaId: 'm1', url: 'u', fields: { k: 'v' }, expiresAt });
});

test('onboarding tickets force the ONBOARDING category and delegate reads/writes', async () => {
  const create = jest.fn(async () => 't1');
  const list = jest.fn(async () => ({ items: [], nextCursor: null }));
  const detail = jest.fn(async () => ({ ticket: {} }));
  const message = jest.fn(async () => 'm1');
  const support = { create, list, detail, message } as unknown as Support;
  const tickets = new RiderOnboardingSupport(support);

  await tickets.create('u1', 'need help');
  expect(create).toHaveBeenCalledWith(
    'u1',
    { category: 'ONBOARDING', body: 'need help', reference: undefined },
    expect.objectContaining({ beforeCreate: expect.any(Function) }),
  );

  await tickets.list('u1');
  expect(list).toHaveBeenCalledWith('u1', false, undefined, undefined, 'ONBOARDING');

  await tickets.detail('u1', 't1');
  expect(detail).toHaveBeenCalledWith('u1', 't1', false, undefined, undefined, 'ONBOARDING');

  await tickets.message('u1', 't1', 'reply text');
  expect(message).toHaveBeenCalledWith(
    'u1',
    't1',
    { body: 'reply text', category: 'ONBOARDING', reference: undefined },
    expect.objectContaining({ beforeMessage: expect.any(Function) }),
  );
});
