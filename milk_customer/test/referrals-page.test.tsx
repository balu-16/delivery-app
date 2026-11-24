/// <reference types="jest" />
import { fireEvent, render, screen } from '@testing-library/react-native';
import Referrals from '../app/referrals';
import { referralsApi } from '../src/api/referrals';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = require('react');
    React.useEffect(() => callback(), [callback]);
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('idem-key-1') }));
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn().mockResolvedValue('customer-token') }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../src/store/customer', () => {
  const mockState = { error: null, clearError: jest.fn() };
  const useCustomer = (selector?: (state: typeof mockState) => unknown) => selector ? selector(mockState) : mockState;
  useCustomer.getState = () => mockState;
  return { useCustomer };
});
jest.mock('../src/api/referrals', () => {
  const actual = jest.requireActual('../src/api/referrals') as typeof import('../src/api/referrals');
  return { ...actual, referralsApi: { view: jest.fn(), history: jest.fn(), createInvite: jest.fn() } };
});
jest.mock('../components/ui/Button', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return { Button: ({ label, onPress, disabled, loading }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean }) => React.createElement(Pressable, { onPress, disabled: disabled || loading, accessibilityRole: 'button' }, React.createElement(Text, null, label)) };
});
jest.mock('../components/ui/Chip', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return { Chip: ({ label, onPress }: { label: string; onPress: () => void }) => React.createElement(Pressable, { onPress, accessibilityRole: 'button' }, React.createElement(Text, null, label)) };
});
jest.mock('../components/ui/Screen', () => {
  const React = require('react'); const { View } = require('react-native');
  return { Screen: ({ children }: { children: React.ReactNode }) => React.createElement(View, null, children) };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const ENABLED_VIEW = { enabled: true, code: 'ABCDEF0123456789', successfulReferrals: 2, pendingReferrals: 1, rewardPaise: '1000', rewardExpiryMonths: 3, freeDeliveryAvailable: false };
const DISABLED_VIEW = { enabled: false, code: null, successfulReferrals: 1, pendingReferrals: 1, rewardPaise: '1000', rewardExpiryMonths: 3, freeDeliveryAvailable: false };
const SUCCESSFUL_ITEMS = [
  { id: '01800000-0000-7000-8000-00000000s1', label: null, status: 'successful' as const, createdAt: '2026-11-18T10:00:00.000Z', completedAt: '2026-11-18T10:00:00.000Z', rewardPaise: '1000', creditExpiresAt: '2026-12-18T10:00:00.000Z' },
  { id: '01800000-0000-7000-8000-00000000s2', label: 'cousin', status: 'successful' as const, createdAt: '2026-11-19T10:00:00.000Z', completedAt: '2026-11-19T10:00:00.000Z', rewardPaise: '1000', creditExpiresAt: '2026-12-19T10:00:00.000Z' },
];
const PENDING_ITEMS = [
  { id: '01800000-0000-7000-8000-00000000p1', label: 'neighbour', status: 'pending' as const, createdAt: '2026-11-20T10:00:00.000Z', inviteCode: 'INV-ABCDEF0123456789ABCDEF0123456789' },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(referralsApi.view).mockResolvedValue(ENABLED_VIEW);
  jest.mocked(referralsApi.history).mockImplementation(async (_token, status) => ({
    items: status === 'successful' ? SUCCESSFUL_ITEMS : PENDING_ITEMS,
    nextCursor: null,
  }));
  jest.mocked(referralsApi.createInvite).mockResolvedValue({ reference: '01800000-0000-7000-8000-00000000n1', code: 'INV-11111111111111111111111111111111', createdAt: '2026-11-20T11:00:00.000Z' });
  const { Share } = require('react-native');
  Share.share = jest.fn().mockResolvedValue({ action: 'sharedAction' });
});

test('shows the permanent ID by default with counts and successful rows', async () => {
  await render(<Referrals />);
  expect(await screen.findByLabelText('Your referral ID')).toBeTruthy();
  expect(screen.getByText('Successful (2)')).toBeTruthy();
  expect(screen.getByText('Pending (1)')).toBeTruthy();
  expect(screen.getAllByText(/₹10\.00 confirmed/)).toHaveLength(2);
  expect(screen.getByText('cousin')).toBeTruthy();
});

test('explains the reward amount and expiry from the summary', async () => {
  await render(<Referrals />);
  // View carries rewardPaise '1000' and rewardExpiryMonths 3: both render.
  expect(await screen.findByText(/₹10\.00 in promotional wallet credit\. It expires 3 calendar months/)).toBeTruthy();
});

test('copy and share give feedback with the permanent code', async () => {
  const { Share } = require('react-native');
  await render(<Referrals />);
  await screen.findByLabelText('Your referral ID');
  await fireEvent.press(screen.getByText('Copy code'));
  expect(await screen.findByText('Copied')).toBeTruthy();
  await fireEvent.press(screen.getByText('Share invite'));
  expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('ABCDEF0123456789') }));
});

test('pending filter shows awaiting rows and creates a tracked invite', async () => {
  const { Share } = require('react-native');
  await render(<Referrals />);
  await screen.findByText('Successful (2)');
  await fireEvent.press(screen.getByText('Pending (1)'));
  expect(await screen.findByText('Awaiting verified signup')).toBeTruthy();
  expect(screen.getByText('INV-ABCDEF0123456789ABCDEF0123456789')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Private note'), '  friend  ');
  await fireEvent.press(screen.getByText('Create invite & share'));
  expect(referralsApi.createInvite).toHaveBeenCalledWith('customer-token', 'friend', 'idem-key-1');
  expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('INV-11111111111111111111111111111111') }));
});

test('a failed share retries the same invite without a second API call', async () => {
  const { Share } = require('react-native');
  Share.share = jest.fn().mockRejectedValueOnce(new Error('dismissed')).mockResolvedValue({ action: 'sharedAction' });
  await render(<Referrals />);
  await screen.findByText('Successful (2)');
  await fireEvent.press(screen.getByText('Pending (1)'));
  await screen.findByText('Awaiting verified signup');
  await fireEvent.press(screen.getByText('Create invite & share'));
  expect(await screen.findByText(/Created INV-111111/)).toBeTruthy();
  expect(referralsApi.createInvite).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Share the created invite'));
  expect(referralsApi.createInvite).toHaveBeenCalledTimes(1);
  expect(Share.share).toHaveBeenCalledTimes(2);
});

test('disabled earning keeps prior history visible while actions stay disabled', async () => {
  jest.mocked(referralsApi.view).mockResolvedValue(DISABLED_VIEW);
  await render(<Referrals />);
  expect(await screen.findByText('Referral rewards are temporarily unavailable.')).toBeTruthy();
  expect(screen.getAllByText(/₹10\.00 confirmed/)).toHaveLength(2);
  expect(screen.queryByText('Copy code')).toBeNull();
});
