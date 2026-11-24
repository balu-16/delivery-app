/// <reference types="jest" />
import { ApiError } from '../src/api/client';
import { referralsApi, shareInviteMessage, shareReferralMessage } from '../src/api/referrals';

const previousUrl = process.env.EXPO_PUBLIC_API_URL;
const previousSignup = process.env.EXPO_PUBLIC_REFERRAL_SIGNUP_URL;
afterAll(() => { process.env.EXPO_PUBLIC_API_URL = previousUrl; process.env.EXPO_PUBLIC_REFERRAL_SIGNUP_URL = previousSignup; });

test('view, history and invite calls use the frozen paths and idempotency header', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  globalThis.fetch = jest.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, code: 'ABCDEF0123456789', successfulReferrals: 2, pendingReferrals: 1, rewardPaise: '1000', rewardExpiryMonths: 3, freeDeliveryAvailable: false }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ reference: '01800000-0000-7000-8000-0000000000aa', code: 'INV-ABCDEF0123456789ABCDEF0123456789', createdAt: '2026-11-20T10:00:00.000Z' }), { status: 201 }));
  await expect(referralsApi.view('token')).resolves.toMatchObject({ code: 'ABCDEF0123456789', pendingReferrals: 1, rewardExpiryMonths: 3 });
  expect((globalThis.fetch as jest.Mock).mock.calls[0][0]).toBe('http://192.168.1.10:3000/v1/customer/referrals');
  await expect(referralsApi.history('token', 'pending', 'cursor-1', 20)).resolves.toEqual({ items: [], nextCursor: null });
  expect((globalThis.fetch as jest.Mock).mock.calls[1][0]).toBe('http://192.168.1.10:3000/v1/customer/referrals/history?status=pending&limit=20&cursor=cursor-1');
  await expect(referralsApi.createInvite('token', 'neighbour', 'idem-key')).resolves.toMatchObject({ code: 'INV-ABCDEF0123456789ABCDEF0123456789' });
  const inviteCall = (globalThis.fetch as jest.Mock).mock.calls[2];
  expect(inviteCall[0]).toBe('http://192.168.1.10:3000/v1/customer/referrals/invites');
  expect(inviteCall[1].method).toBe('POST');
  expect(inviteCall[1].headers['Idempotency-Key']).toBe('idem-key');
  expect(JSON.parse(inviteCall[1].body)).toEqual({ label: 'neighbour' });
});

test('invite without a label sends an empty object', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ reference: '01800000-0000-7000-8000-0000000000aa', code: 'INV-ABCDEF0123456789ABCDEF0123456789', createdAt: '2026-11-20T10:00:00.000Z' }), { status: 201 }));
  await referralsApi.createInvite('token', undefined, 'idem-key');
  expect(JSON.parse((globalThis.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({});
});

test('share texts carry the copyable code and signup instructions', () => {
  process.env.EXPO_PUBLIC_REFERRAL_SIGNUP_URL = '';
  expect(shareReferralMessage('ABCDEF0123456789')).toContain('ABCDEF0123456789');
  expect(shareReferralMessage('ABCDEF0123456789')).toContain('free delivery');
  expect(shareInviteMessage('INV-ABCDEF0123456789ABCDEF0123456789')).toContain('INV-ABCDEF0123456789ABCDEF0123456789');
  expect(shareInviteMessage('INV-ABCDEF0123456789ABCDEF0123456789')).toContain('verify your email');
});

test('used-invite failures surface as typed API errors', () => {
  const error = new ApiError(409, 'REFERRAL_INVITE_USED');
  expect(error.status).toBe(409);
  expect(error.code).toBe('REFERRAL_INVITE_USED');
});
