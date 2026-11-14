import React from 'react';
import { act, render } from '@testing-library/react-native';
import { PartnerApp } from '../src/screens/PartnerApp';
import { riderApi } from '../src/api';
import { getAccessToken } from '../src/auth/session';

jest.mock('../src/api', () => ({
  ApiError: Error,
  riderApi: { bootstrap: jest.fn(), application: jest.fn() },
}));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn() }));
jest.mock('../src/tracking', () => ({ stopTracking: jest.fn() }));
jest.mock('../src/components/Brand', () => ({ Brand: () => null }));
jest.mock('../src/components/Ui', () => {
  const native = require('react-native');
  return { Button: () => null, Text: native.Text };
});
jest.mock('../src/screens/ApplicationScreen', () => ({ ApplicationScreen: () => null }));
jest.mock('../src/screens/LivePartner', () => ({ LivePartner: () => null }));

afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

test('refreshes a stale sign-in token while waiting for the rider group', async () => {
  jest.useFakeTimers();
  let refreshed = false;
  jest.mocked(getAccessToken).mockImplementation(async () => { refreshed = true; return 'updated'; });
  jest.mocked(riderApi.bootstrap).mockImplementation(async () => ({
    userId: 'rider', status: 'PENDING', groupPending: !refreshed,
  }));
  jest.mocked(riderApi.application).mockResolvedValue({
    userId: 'rider', status: 'PENDING', vehicleType: null, vehicleNo: null,
    homeStoreId: null, requiredDocuments: [], documents: [],
  });
  render(<PartnerApp identity={{ subject: 'rider', name: 'Rider', email: 'rider@example.test' }} onSignOut={async () => {}} />);
  await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
  expect(riderApi.bootstrap).toHaveBeenCalledTimes(4);
  expect(getAccessToken).toHaveBeenCalledWith(true);
  expect(riderApi.application).toHaveBeenCalledTimes(1);
});
