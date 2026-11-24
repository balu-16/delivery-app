/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import Profile from '../app/(tabs)/profile';
import type { CustomerProfile } from '../src/api/customer';
import { profileCoverApi } from '../src/api/profile-cover';
import { CENTERED_CROP, coverCropRect, panCoverCrop } from '../src/profile/cover-crop';
import { pickCoverPhoto, prepareCoverUpload, uploadCoverPhoto } from '../src/profile/cover-photo';

const owner: CustomerProfile = {
  userId: 'owner',
  name: 'Anu Patil',
  email: 'anu@example.test',
  emailVerified: true,
  locale: 'en',
};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => ({}),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24 }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../hooks/useMotionEnabled', () => ({ useMotionEnabled: () => false }));
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn().mockResolvedValue('test-token') }));
jest.mock('../src/agent/client', () => ({
  agentClient: { consentStatus: jest.fn().mockResolvedValue({ accepted: true }) },
}));
jest.mock('../src/api/customer', () => ({
  customerApi: {},
  customerDetailsApi: {
    referral: jest.fn().mockResolvedValue({ enabled: true, rewardPaise: '1000' }),
    unreadCount: jest.fn().mockResolvedValue({ count: 3 }),
  },
}));
jest.mock('../src/api/profile-cover', () => ({
  profileCoverApi: { get: jest.fn(), save: jest.fn(), target: jest.fn() },
  coverMediaUrl: (value: string) => new URL(value, 'https://example.test'),
}));
jest.mock('../src/profile/cover-photo', () => ({
  pickCoverPhoto: jest.fn(),
  prepareCoverUpload: jest.fn(),
  uploadCoverPhoto: jest.fn(),
  deleteCoverTemp: jest.fn(),
}));
jest.mock('../src/store/customer', () => {
  const state = {
    profile: null,
    wallet: null,
    loadWallet: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn(),
    error: null,
  };
  const useCustomer = (selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state;
  useCustomer.getState = () => state;
  return { useCustomer };
});
jest.mock('../components/ui/BottomSheet', () => ({
  BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? children : null,
}));
jest.mock('../components/ui/Button', () => {
  const { createElement } = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    Button: ({
      label,
      onPress,
      disabled,
      loading,
    }: {
      label: string;
      onPress: () => void;
      disabled?: boolean;
      loading?: boolean;
    }) =>
      createElement(
        Pressable,
        { onPress, disabled: disabled || loading, accessibilityRole: 'button' },
        createElement(Text, null, label),
      ),
  };
});

const { useCustomer } = jest.requireMock('../src/store/customer');
const state = useCustomer.getState() as {
  profile: CustomerProfile;
  wallet: { userId: string; cashPaise: string; promoPaise: string };
};

beforeEach(() => {
  jest.clearAllMocks();
  state.profile = owner;
  state.wallet = { userId: owner.userId, cashPaise: '2000', promoPaise: '500' };
  jest.mocked(profileCoverApi.get).mockResolvedValue({ kind: 'default', version: '0', imageUrl: null });
});

test('the photo preview and export share a bounded 16:9 crop', () => {
  const photo = { width: 1200, height: 2000 };
  expect(coverCropRect(photo, CENTERED_CROP)).toEqual({
    originX: 0,
    originY: 663,
    width: 1200,
    height: 675,
  });
  const moved = panCoverCrop(photo, { ...CENTERED_CROP, zoom: 2 }, 5000, -5000, 320);
  const crop = coverCropRect(photo, moved);
  expect(crop.originX).toBe(0);
  expect(crop.originY + crop.height).toBe(photo.height);
  expect(crop.width * 9).toBe(crop.height * 16);
});

test('renders the live account summary and links to working shortcuts', async () => {
  await render(<Profile />);
  expect(screen.getByText('Email verified')).toBeTruthy();
  expect(await screen.findByText('Invite friends & earn ₹10.00')).toBeTruthy();
  expect(screen.getByText('₹25.00')).toBeTruthy();
  expect(screen.getByText('3 unread')).toBeTruthy();
  for (const [label, path] of [
    ['Addresses', '/addresses'],
    ['Wallet, ₹25.00', '/wallet'],
    ['Refer & Earn', '/referrals'],
    ['Notifications, 3 unread', '/notifications'],
    ['Help & Support', '/support'],
  ]) {
    await fireEvent.press(screen.getByRole('button', { name: label }));
    expect(router.push).toHaveBeenLastCalledWith(path);
  }
});

test('saves a preset only on confirmation and restores the default', async () => {
  jest
    .mocked(profileCoverApi.save)
    .mockResolvedValueOnce({ kind: 'preset', presetId: 'farm-meadow', version: '1', imageUrl: null })
    .mockResolvedValueOnce({ kind: 'default', version: '2', imageUrl: null });
  await render(<Profile />);
  await waitFor(() => expect(profileCoverApi.get).toHaveBeenCalled());
  await fireEvent.press(screen.getByRole('button', { name: 'Change cover' }));
  await fireEvent.press(screen.getByText('Farm meadow'));
  expect(profileCoverApi.save).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Save cover'));
  expect(profileCoverApi.save).toHaveBeenLastCalledWith(
    'test-token',
    { kind: 'preset', presetId: 'farm-meadow' },
    '0',
    expect.anything(),
  );
  await waitFor(() => expect(screen.queryByText('Farm presets')).toBeNull());
  await fireEvent.press(screen.getByRole('button', { name: 'Change cover' }));
  await fireEvent.press(screen.getByText('Restore default'));
  await fireEvent.press(screen.getByText('Save cover'));
  expect(profileCoverApi.save).toHaveBeenLastCalledWith(
    'test-token',
    { kind: 'default' },
    '1',
    expect.anything(),
  );
});

test('keeps the draft on a network failure and commits the cropped upload after retry', async () => {
  const picked = { uri: 'file:///tmp/crop-source.jpg', width: 1200, height: 2000 };
  jest.mocked(pickCoverPhoto).mockResolvedValue(picked);
  jest
    .mocked(prepareCoverUpload)
    .mockResolvedValue({ uri: 'file:///tmp/cropped.jpg', data: { size: 32 } as Blob });
  jest
    .mocked(profileCoverApi.target)
    .mockResolvedValue({
      mediaId: 'cover-file',
      expiresAt: '2027-01-01T00:00:00.000Z',
      url: '/dev/private-media/cover-file',
      fields: {},
    });
  jest
    .mocked(uploadCoverPhoto)
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(undefined);
  jest
    .mocked(profileCoverApi.save)
    .mockResolvedValue({
      kind: 'photo',
      mediaId: 'cover-file',
      version: '1',
      imageUrl: 'https://example.test/blob',
    });
  await render(<Profile />);
  await fireEvent.press(screen.getByRole('button', { name: 'Change cover' }));
  await fireEvent.press(screen.getByText('Choose photo'));
  await fireEvent.press(await screen.findByText('Zoom in'));
  await fireEvent.press(screen.getByText('Save cover'));
  expect(await screen.findByText(/Your previous cover is still shown/)).toBeTruthy();
  expect(profileCoverApi.save).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByText('Save cover'));
  expect(prepareCoverUpload).toHaveBeenLastCalledWith(picked, { x: 0.5, y: 0.5, zoom: 1.25 });
  expect(profileCoverApi.save).toHaveBeenCalledWith(
    'test-token',
    { kind: 'photo', mediaId: 'cover-file' },
    '0',
    expect.anything(),
  );
});

test('discards a pending cover response from a previous signed-in account', async () => {
  let finish!: (response: Awaited<ReturnType<typeof profileCoverApi.get>>) => void;
  jest.mocked(profileCoverApi.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await render(<Profile />);
  await waitFor(() => expect(profileCoverApi.get).toHaveBeenCalledTimes(1));
  state.profile = { ...owner, userId: 'other', name: 'A second customer', emailVerified: false };
  await view.rerender(<Profile />);
  await act(() => finish({ kind: 'preset', presetId: 'farm-meadow', version: '9', imageUrl: null }));
  await fireEvent.press(screen.getByRole('button', { name: 'Change cover' }));
  await fireEvent.press(screen.getByText('Restore default'));
  jest.mocked(profileCoverApi.save).mockResolvedValue({ kind: 'default', version: '0', imageUrl: null });
  await fireEvent.press(screen.getByText('Save cover'));
  expect(profileCoverApi.save).toHaveBeenCalledWith(
    'test-token',
    { kind: 'default' },
    '0',
    expect.anything(),
  );
});
