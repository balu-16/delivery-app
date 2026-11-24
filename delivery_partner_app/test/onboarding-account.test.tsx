/// <reference types="jest" />
import { act, render, screen } from '@testing-library/react-native';
import { ApplicationScreen } from '../src/screens/ApplicationScreen';
import { riderApi } from '../src/api';
import { clearStoreCache } from '../src/onboarding/storeCache';

/**
 * Account-switch / stale-read isolation tests. Kept in a separate file because
 * RNTL v14's `rerender` leaves the global `screen` pointing at a stale root;
 * running this test mid-suite poisons subsequent renders. It is the only
 * test that needs `rerender`, so it lives here alone.
 */
jest.mock('../src/api', () => {
  class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  class UploadError extends Error {}
  return {
    ApiError,
    UploadError,
    riderApi: {
      application: jest.fn(),
      onboardingStores: jest.fn(),
      selectOnboardingStore: jest.fn(),
      profile: jest.fn(),
      documentTarget: jest.fn(),
      document: jest.fn(),
      createTicket: jest.fn(),
      tickets: jest.fn(),
      ticket: jest.fn(),
      ticketMessage: jest.fn(),
      bootstrap: jest.fn(),
      status: jest.fn(),
    },
    uploadFile: jest.fn(),
  };
});
jest.mock('../src/components/Brand', () => ({ Brand: () => null }));
jest.mock('../src/components/Skeleton', () => {
  const React = require('react');
  const native = require('react-native');
  return {
    CardListSkeleton: ({ label }: { label?: string }) => React.createElement(native.View, { accessibilityLabel: label, accessibilityState: { busy: true } }),
    FormSkeleton: () => null,
    SkeletonBlock: () => null,
  };
});
jest.mock('../src/components/Ui', () => {
  const React = require('react');
  const native = require('react-native');
  return {
    Text: native.Text,
    Card: ({ children }: { children: React.ReactNode }) => React.createElement(native.View, null, children),
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
      React.createElement(
        native.Pressable,
        { onPress, disabled, accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled: !!disabled } },
        React.createElement(native.Text, null, label),
      ),
    PageTitle: ({ title, subtitle }: { title: string; subtitle?: string }) =>
      React.createElement(native.View, null,
        React.createElement(native.Text, null, title),
        subtitle ? React.createElement(native.Text, null, subtitle) : null,
      ),
    IconBox: () => null,
    IconButton: () => null,
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 } }));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', deleteAsync: jest.fn() }));

type AppShape = any;

function baselineApp(overrides: Record<string, unknown> = {}): AppShape {
  return {
    userId: 'rider-1',
    status: 'PENDING',
    vehicleType: null,
    vehicleNo: null,
    homeStoreId: null, homeStore: null,
    maxDocumentBytes: 5 * 1024 * 1024,
    requiredDocuments: ['licence'],
    documents: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const applicationMock = jest.mocked(riderApi).application as jest.Mock;
const storesMock = jest.mocked(riderApi).onboardingStores as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  clearStoreCache('rider-1');
  clearStoreCache('rider-2');
  applicationMock.mockResolvedValue(baselineApp());
  storesMock.mockResolvedValue([{ id: 'store-a', name: 'Alpha Store', city: 'Bengaluru' }]);
});

test('account switch discards a stale outstanding read instead of reverting confirmed data', async () => {
  const stale = deferred<any>();
  applicationMock.mockReturnValueOnce(stale.promise);
  const first = await render(<ApplicationScreen application={baselineApp({ status: 'PENDING' })} signOut={async () => {}} accountId="rider-1" />);
  type Node = { props?: Record<string, unknown>; children?: Node[] };
  let element: Record<string, unknown> | undefined;
  const stack: Node[] = [screen.toJSON() as Node];
  while (stack.length && !element) {
    const node = stack.pop()!;
    element = node.props?.refreshControl as Record<string, unknown> | undefined;
    if (!element && node.children) stack.push(...node.children);
  }
  const control = (element?.props ?? {}) as Record<string, unknown>;
  const pendingRefresh = (control.onRefresh as () => Promise<unknown>)();
  await act(async () => {
    await first.rerender(<ApplicationScreen application={baselineApp({ status: 'UNDER_REVIEW', userId: 'rider-2' })} signOut={async () => {}} accountId="rider-2" />);
  });
  await act(async () => { stale.resolve(baselineApp({ status: 'PENDING', userId: 'rider-1' })); });
  await act(async () => { await pendingRefresh; });
  expect(screen.queryByText('Your application has been submitted. The decision will appear here.')).toBeTruthy();
});
