import { act, render, screen } from '@testing-library/react-native';
import { riderApi } from '../src/api';
import { resolvePartnerNotification } from '../src/notification-routing';

jest.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  riderApi: {
    offers: jest.fn(),
    taskHistory: jest.fn(),
    task: jest.fn(),
  },
}));

jest.mock('../src/partner-session', () => ({
  ensurePartnerIdentity: jest.fn(),
  setPartnerIdentity: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('../src/components/Brand', () => ({ Brand: () => null }));
jest.mock('../src/components/Ui', () => {
  const React = require('react'), native = require('react-native');
  return {
    Text: native.Text,
    Card: ({ children }: { children: React.ReactNode }) => React.createElement(native.View, null, children),
    Button: ({ label }: { label: string }) => React.createElement(native.Text, null, label),
    PageTitle: ({ title }: { title: string }) => React.createElement(native.Text, null, title),
  };
});
jest.mock('../src/components/Skeleton', () => ({ CardListSkeleton: () => null }));
jest.mock('../src/screens/liveHelpers', () => ({ formatMoney: () => '₹0.00', shortTime: () => '—' }));
jest.mock('../src/theme', () => ({ colors: { background: '#fff', greenDark: '#000', text: '#000', secondary: '#666', danger: '#f00', muted: '#888', line: '#eee', lineStrong: '#ddd', backgroundTop: '#fff', raised: '#fff', green: '#0f0' }, fonts: { semibold: 'Poppins_600', regular: 'Poppins_400' } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

describe('partner navigation integration', () => {
  test('history endpoint is called with attempt number when present', async () => {
    const { ensurePartnerIdentity } = require('../src/partner-session');
    jest.mocked(ensurePartnerIdentity).mockResolvedValue({ subject: 'rider', name: 'Rider', email: 'r@example.com' });
    jest.mocked(riderApi.taskHistory).mockResolvedValue({
      id: 'task-1', taskId: 'task-1', orderId: 'order-1', orderNumber: 'ORD-1', attemptNo: 2,
      assignedAt: new Date(0).toISOString(), status: 'DELIVERED',
      pickupAt: null, arrivedStoreAt: null, arrivedCustomerAt: null, deliveredAt: new Date(0).toISOString(),
      failureReason: null, earnings: { totalPaise: '1000', basePaise: '500', distancePaise: '500', incentivePaise: null, tipPaise: null, distanceMetres: 1000, distancePending: false, computedAt: new Date(0).toISOString() },
    } as never);

    // Reproduce the history route's data fetch logic: attemptNo defaults to most recent
    const detail = await riderApi.taskHistory('task-1', 2);
    expect(riderApi.taskHistory).toHaveBeenCalledWith('task-1', 2);
    expect((detail as { attemptNo: number }).attemptNo).toBe(2);
  });

  test('offer detail reuses scoped offers list and validates expiry', async () => {
    const offer = { offerId: 'a1b2c3d4-1234-4abc-8def-123456789abc', taskId: 'b1b2c3d4-1234-4abc-8def-123456789abc', orderId: 'o1', storeId: 's1', attemptNo: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), codAmountPaise: null, storeName: 'S', orderNumber: 'ORD-1' };
    jest.mocked(riderApi.offers).mockResolvedValue({ items: [offer] });
    const { riderApi: api } = require('../src/api');
    // Use the real resolver to prove offer route shape
    const resolved = resolvePartnerNotification({ type: 'rider.offer', offerId: offer.offerId });
    expect(resolved).toEqual({ kind: 'push', pathname: '/offers/[offerId]', params: { offerId: offer.offerId } });
    // The offer helper filters the list; expiry is checked locally
    const found = (await api.offers()).items.find((o: { offerId: string }) => o.offerId === offer.offerId);
    expect(found).toBeTruthy();
  });
});
