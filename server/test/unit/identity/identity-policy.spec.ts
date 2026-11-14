import {
  authorizeIdentity,
  documentsApproved,
  documentsReady,
} from '../../../src/modules/identity/domain/identity-policy.js';
import type {
  Principal,
  VerifiedIdentity,
} from '../../../src/modules/identity/contracts/identity.js';

const identity: VerifiedIdentity = {
  pool: 'WORKFORCE',
  sub: 'subject',
  tokenUse: 'access',
  groups: ['RIDER'],
  expiresAt: 9999999999,
};
const principal: Principal = {
  userId: 'user',
  pool: 'WORKFORCE',
  sub: 'subject',
  roles: ['RIDER'],
  status: 'ACTIVE',
  emailVerified: true,
  authVersion: '1',
  riderStatus: 'PENDING',
};
test('authorization intersects current roles with token groups and honors pending rider exception', () => {
  expect(authorizeIdentity(identity, principal, 'rider', true).roles).toEqual(['RIDER']);
  expect(() => authorizeIdentity(identity, principal, 'rider', false)).toThrow(
    'RIDER_NOT_APPROVED',
  );
  expect(() =>
    authorizeIdentity(identity, { ...principal, status: 'BLOCKED' }, 'rider', true),
  ).toThrow('ACCOUNT_DISABLED');
  expect(() => authorizeIdentity(identity, principal, 'admin', false)).toThrow('FORBIDDEN');
  expect(() => authorizeIdentity({ ...identity, groups: [] }, principal, 'rider', true)).toThrow(
    'FORBIDDEN',
  );
  expect(() =>
    authorizeIdentity({ ...identity, groups: ['RIDER', 'SUPER_ADMIN'] }, principal, 'rider', true),
  ).toThrow('FORBIDDEN');
  expect(() =>
    authorizeIdentity({ ...identity, groups: ['RIDER', 'ADMIN'] }, principal, 'rider', true),
  ).toThrow('FORBIDDEN');
  expect(() => authorizeIdentity(identity, null, 'rider', true)).toThrow('PROFILE_NOT_INITIALIZED');
  expect(() => authorizeIdentity(identity, { ...principal, sub: 'other' }, 'rider', true)).toThrow(
    'FORBIDDEN',
  );
  expect(
    authorizeIdentity(identity, { ...principal, riderStatus: 'APPROVED' }, 'rider', false).userId,
  ).toBe('user');
});
test('customers also need exactly the matching customer group', () => {
  const customer = { ...identity, pool: 'CUSTOMER' as const, groups: ['CUSTOMER'] };
  const account = {
    ...principal,
    pool: 'CUSTOMER' as const,
    roles: ['CUSTOMER' as const],
    riderStatus: null,
  };
  expect(authorizeIdentity(customer, account, 'customer', false).roles).toEqual(['CUSTOMER']);
  expect(() => authorizeIdentity({ ...customer, groups: [] }, account, 'customer', false)).toThrow(
    'FORBIDDEN',
  );
  expect(() =>
    authorizeIdentity({ ...customer, groups: ['CUSTOMER', 'RIDER'] }, account, 'customer', false),
  ).toThrow('FORBIDDEN');
});
test('required documents must all be present and approved, with no empty policy bypass', () => {
  const docs = [
    { document_type: 'licence', status: 'APPROVED' },
    { document_type: 'id', status: 'PENDING' },
  ];
  expect(documentsReady(['licence', 'id'], docs)).toBe(true);
  expect(documentsApproved(['licence', 'id'], docs)).toBe(false);
  expect(documentsReady(['licence', 'id'], [docs[0]!])).toBe(false);
  expect(
    documentsReady(['licence', 'id'], [docs[0]!, { document_type: 'id', status: 'REJECTED' }]),
  ).toBe(false);
  expect(
    documentsApproved(['licence', 'id'], [docs[0]!, { document_type: 'id', status: 'APPROVED' }]),
  ).toBe(true);
  expect(documentsReady([], [])).toBe(false);
  expect(documentsApproved([], [])).toBe(false);
});
