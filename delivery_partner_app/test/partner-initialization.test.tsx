import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { PartnerApp } from '../src/screens/PartnerApp';
import { ApiError, riderApi } from '../src/api';
import { getAccessToken } from '../src/auth/session';

jest.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    traceId?: string;
    constructor(code: string, _status: number, reference?: string) {
      super(code);
      this.code = code;
      this.traceId = reference;
    }
  },
  riderApi: { bootstrap: jest.fn(), application: jest.fn() },
}));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn() }));
jest.mock('../src/tracking', () => ({ stopTracking: jest.fn() }));
jest.mock('../src/components/Brand', () => ({ Brand: () => null }));
jest.mock('../src/components/Ui', () => {
  const native = require('react-native');
  return { Button: () => null, Text: native.Text };
});
jest.mock('../src/screens/ApplicationScreen', () => {
  const { Text } = require('react-native');
  return { ApplicationScreen: ({ application }: { application: { status: string } }) => <Text>{application.status}</Text> };
});
jest.mock('../src/screens/LivePartner', () => {
  const { Text } = require('react-native');
  return { LivePartner: () => <Text>Delivery home</Text> };
});

afterEach(() => {
  jest.useRealTimers();
  jest.mocked(riderApi.application).mockReset();
  jest.mocked(riderApi.bootstrap).mockReset();
  jest.mocked(getAccessToken).mockReset();
  jest.restoreAllMocks();
});

const identity = { subject: 'rider', name: 'Rider', email: 'rider@example.test' };
const draft = {
  userId: 'rider', status: 'PENDING' as const, vehicleType: null, vehicleNo: null,
  homeStoreId: null, homeStore: null, requiredDocuments: [], documents: [],
};

test('a returning approved rider goes straight through the application read', async () => {
  jest.mocked(riderApi.application).mockResolvedValue({
    userId: 'rider', status: 'APPROVED', vehicleType: null, vehicleNo: null,
    homeStoreId: null, homeStore: null, requiredDocuments: [], documents: [],
  });
  await render(<PartnerApp identity={{ subject: 'rider', name: 'Rider', email: 'rider@example.test' }} onSignOut={async () => {}} />);
  expect(riderApi.application).toHaveBeenCalledTimes(1);
  expect(riderApi.bootstrap).not.toHaveBeenCalled();
});

test('refreshes a stale sign-in token while waiting for the rider group', async () => {
  jest.useFakeTimers();
  let refreshed = false;
  jest.mocked(getAccessToken).mockImplementation(async () => { refreshed = true; return 'updated'; });
  jest.mocked(riderApi.bootstrap).mockImplementation(async () => ({
    userId: 'rider', status: 'PENDING', groupPending: !refreshed,
  }));
  jest.mocked(riderApi.application).mockRejectedValueOnce(new ApiError('PROFILE_NOT_INITIALIZED', 403)).mockResolvedValue({
    userId: 'rider', status: 'PENDING', vehicleType: null, vehicleNo: null,
    homeStoreId: null, homeStore: null, requiredDocuments: [], documents: [],
  });
  await render(<PartnerApp identity={{ subject: 'rider', name: 'Rider', email: 'rider@example.test' }} onSignOut={async () => {}} />);
  await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
  expect(riderApi.bootstrap).toHaveBeenCalledTimes(4);
  expect(getAccessToken).toHaveBeenCalledWith(true);
  expect(riderApi.application).toHaveBeenCalledTimes(2);
});

test('a verified grouped rider opens the draft after a single bootstrap', async () => {
  jest.mocked(riderApi.application)
    .mockRejectedValueOnce(new ApiError('PROFILE_NOT_INITIALIZED', 403))
    .mockResolvedValueOnce(draft);
  jest.mocked(riderApi.bootstrap).mockResolvedValueOnce({ userId: 'rider', status: 'PENDING', groupPending: false });
  await render(<PartnerApp identity={identity} onSignOut={async () => {}} />);
  expect(await screen.findByText('PENDING')).toBeTruthy();
  expect(riderApi.bootstrap).toHaveBeenCalledTimes(1);
  expect(getAccessToken).not.toHaveBeenCalled();
});

test('an account conflict shows its support reference without polling enrollment', async () => {
  jest.mocked(riderApi.application).mockRejectedValueOnce(new ApiError('PROFILE_NOT_INITIALIZED', 403));
  jest.mocked(riderApi.bootstrap).mockRejectedValueOnce(
    new ApiError('RIDER_ENROLLMENT_REQUIRES_REVIEW', 409, 'request-123'),
  );
  await render(<PartnerApp identity={identity} onSignOut={async () => {}} />);
  expect(await screen.findByText('Support reference request-123')).toBeTruthy();
  expect(riderApi.bootstrap).toHaveBeenCalledTimes(1);
});

test('returning to the foreground displays a completed review', async () => {
  let onAppStateChange: Parameters<typeof AppState.addEventListener>[1] | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onAppStateChange = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(riderApi.application)
    .mockResolvedValueOnce({ ...draft, status: 'UNDER_REVIEW' })
    .mockResolvedValueOnce({ ...draft, status: 'APPROVED' });
  await render(<PartnerApp identity={identity} onSignOut={async () => {}} />);
  expect(await screen.findByText('UNDER_REVIEW')).toBeTruthy();
  await act(async () => { onAppStateChange?.('active'); });
  expect(await screen.findByText('Delivery home')).toBeTruthy();
});
