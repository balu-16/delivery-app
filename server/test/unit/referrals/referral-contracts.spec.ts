import {
  historyCursor,
  isReusableReferralCode,
  isTrackedInviteCode,
  normalizeInviteLabel,
  normalizeReferralCode,
} from '../../../src/modules/referrals/contracts/referrals.js';

test('normalizes both code formats and rejects near-misses', () => {
  expect(normalizeReferralCode('  abcdef0123456789 ')).toBe('ABCDEF0123456789');
  expect(normalizeReferralCode(' inv-abcdef0123456789abcdef0123456789 ')).toBe(
    'INV-ABCDEF0123456789ABCDEF0123456789',
  );
  expect(isReusableReferralCode('ABCDEF0123456789')).toBe(true);
  expect(isReusableReferralCode('INV-ABCDEF0123456789ABCDEF0123456789')).toBe(false);
  expect(isTrackedInviteCode('INV-ABCDEF0123456789ABCDEF0123456789')).toBe(true);
  expect(isTrackedInviteCode('ABCDEF0123456789')).toBe(false);
  expect(isTrackedInviteCode('INV-ABCDEF012345678')).toBe(false);
  expect(isReusableReferralCode('ABCDEF012345678')).toBe(false);
  expect(isReusableReferralCode('GGGGGGGGGGGGGGGG')).toBe(false);
});

test('trims invite labels and enforces the 48-character bound', () => {
  expect(normalizeInviteLabel(undefined)).toBeNull();
  expect(normalizeInviteLabel('   ')).toBeNull();
  expect(normalizeInviteLabel('  neighbour  ')).toBe('neighbour');
  expect(normalizeInviteLabel('a'.repeat(48))).toBe('a'.repeat(48));
  expect(() => normalizeInviteLabel('a'.repeat(49))).toThrow('INVALID_INPUT');
});

test('history cursors bind filter and account and keep precision', () => {
  const userA = '01800000-0000-7000-8000-0000000000a1';
  const userB = '01800000-0000-7000-8000-0000000000b2';
  const id = '01800000-0000-7000-8000-0000000000c3';
  const timestamp = '2026-11-20 15:00:00.123456+00';
  const encoded = historyCursor.encode('pending', userA, timestamp, id);
  expect(historyCursor.decode(encoded, 'pending', userA)).toEqual({ timestamp, id });
  expect(() => historyCursor.decode(encoded, 'successful', userA)).toThrow('INVALID_PAGE');
  expect(() => historyCursor.decode(encoded, 'pending', userB)).toThrow('INVALID_PAGE');
  expect(() => historyCursor.decode('not-a-cursor', 'pending', userA)).toThrow('INVALID_PAGE');
  expect(() => historyCursor.decode('', 'pending', userA)).toThrow('INVALID_PAGE');
});
