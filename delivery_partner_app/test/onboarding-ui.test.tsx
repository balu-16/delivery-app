/// <reference types="jest" />
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ApplicationScreen } from '../src/screens/ApplicationScreen';
import { riderApi, uploadFile } from '../src/api';
import { clearAccountTransfers } from '../src/files';
import { clearStoreCache } from '../src/onboarding/storeCache';
import { refreshControlProp } from './pull-refresh-helpers';

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
  class UploadError extends Error {
    kind: string;
    constructor(message: string, kind = 'rejected') { super(message); this.kind = kind; }
  }
  const mockRiderApi = {
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
  };
  return {
    ApiError,
    UploadError,
    riderApi: mockRiderApi,
    uploadFile: jest.fn(),
  };
});
jest.mock('../src/components/Brand', () => ({ Brand: () => null }));
jest.mock('../src/actions', () => ({
  performAction: (_subject: string, _id: string, _action: string, run: (key: string) => Promise<unknown>) => run('support-key'),
}));
jest.mock('../src/components/Skeleton', () => {
  const React = require('react');
  const native = require('react-native');
  return {
    CardListSkeleton: ({ label }: { label?: string }) => React.createElement(native.View, { accessibilityLabel: label, accessibilityState: { busy: true } }),
    FormSkeleton: ({ label }: { label?: string }) => React.createElement(native.View, { accessibilityLabel: label, accessibilityState: { busy: true } }),
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
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', deleteAsync: jest.fn(), makeDirectoryAsync: jest.fn(), moveAsync: jest.fn() }));

type AppShape = any;

const storeA = { id: 'store-a', name: 'Alpha Store', city: 'Bengaluru' };
const storeB = { id: 'store-b', name: 'Beta Store', city: 'Mysuru' };

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

function snapshotApp(overrides: Record<string, unknown> = {}): AppShape {
  return baselineApp(overrides);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const picker = jest.mocked(DocumentPicker.getDocumentAsync);
const mockedExpoFile = jest.mocked(ExpoFile);
const mockedDelete = jest.mocked(FileSystem.deleteAsync);
const mockedApi = jest.mocked(riderApi);
const mockedUploadFile = jest.mocked(uploadFile);

const storeSelect = mockedApi.selectOnboardingStore as jest.Mock;
const profileMock = mockedApi.profile as jest.Mock;
const applicationMock = mockedApi.application as jest.Mock;
const storesMock = mockedApi.onboardingStores as jest.Mock;
const documentTargetMock = mockedApi.documentTarget as jest.Mock;
const documentMock = mockedApi.document as jest.Mock;

afterEach(async () => { await clearAccountTransfers('rider-1'); });

beforeEach(() => {
  jest.clearAllMocks();
  clearStoreCache('rider-1');
  clearStoreCache('rider-2');
  applicationMock.mockResolvedValue(baselineApp());
  storesMock.mockResolvedValue([storeA, storeB]);
  storeSelect.mockResolvedValue({ updated: true, application: snapshotApp({ homeStoreId: 'store-a', homeStore: storeA }) });
  profileMock.mockResolvedValue({ updated: true, application: snapshotApp({ vehicleType: 'Bike', vehicleNo: 'KA01' }) });
  documentTargetMock.mockResolvedValue({ mediaId: 'media-1', url: 'https://storage.test/', fields: { key: 'k' }, expiresAt: '2099-01-01T00:00:00.000Z' });
  documentMock.mockResolvedValue({ updated: true, application: snapshotApp({ documents: [{ id: 'doc-1', type: 'licence', status: 'PENDING', reason: null, createdAt: '2099-01-01T00:00:00.000Z' }] }) });
  mockedApi.tickets.mockResolvedValue({ items: [], nextCursor: null });
  mockedApi.ticket.mockResolvedValue({ messages: [] });
  mockedApi.createTicket.mockResolvedValue({ id: 'support-1' });
  mockedUploadFile.mockResolvedValue(undefined);
  mockedExpoFile.mockImplementation(() => ({ size: 512 }) as unknown as ExpoFile);
  mockedDelete.mockResolvedValue(undefined);
  picker.mockReset();
});

async function renderScreen(app = baselineApp(), accountId = 'rider-1') {
  return render(<ApplicationScreen application={app} signOut={async () => {}} accountId={accountId} />);
}

async function openPicker() {
  // The compact card shows Choose store (no selection) or Change store.
  const control = screen.queryByLabelText('Choose store') ?? screen.queryByLabelText('Change store');
  if (!control) throw new Error('Store opener not found');
  await fireEvent.press(control);
  await act(async () => {});
}

async function openChangePicker() {
  const control = screen.queryByLabelText('Change store') ?? screen.queryByLabelText('Choose store');
  if (!control) throw new Error('Store opener not found');
  await fireEvent.press(control);
  await act(async () => {});
}

test('single tap highlights the store before any network response, then shows Saving and Selected', async () => {
  const gate = deferred<any>();
  storeSelect.mockReturnValue(gate.promise);
  await renderScreen();
  await openPicker();
  expect(screen.getByTestId('store-list')).toBeTruthy();
  expect(screen.queryByText('Alpha Store')).toBeTruthy();

  await fireEvent.press(screen.getByText('Alpha Store'));
  // Modal closed; optimistic card flushed before the write resolves.
  await act(async () => {});
  expect(screen.queryByTestId('store-list')).toBeNull();
  expect(screen.getByText('Alpha Store')).toBeTruthy();
  expect(screen.getByTestId('store-saving')).toBeTruthy();
  expect(storeSelect).toHaveBeenCalledWith('store-a', { signal: expect.anything() });

  await act(async () => { gate.resolve({ updated: true, application: snapshotApp({ homeStoreId: 'store-a', homeStore: storeA }) }); });
  expect(await screen.findByTestId('store-selected')).toBeTruthy();
  expect(screen.queryByTestId('store-saving')).toBeNull();
  expect(screen.getByText('Alpha Store')).toBeTruthy();
  expect(screen.getByText('Bengaluru')).toBeTruthy();
});

test('successful store and vehicle snapshots make zero follow-up application GETs', async () => {
  applicationMock.mockReset();
  storeSelect.mockResolvedValue({ updated: true, application: snapshotApp({ homeStoreId: 'store-b', homeStore: storeB }) });
  profileMock.mockResolvedValue({ updated: true, application: snapshotApp({ homeStoreId: 'store-b', homeStore: storeB, vehicleType: 'Bike', vehicleNo: 'KA09' }) });
  await renderScreen();
  expect(applicationMock).not.toHaveBeenCalled();

  await openPicker();
  await fireEvent.press(screen.getByText('Beta Store'));
  await act(async () => {});
  await screen.findByTestId('store-selected');
  expect(storeSelect).toHaveBeenCalledTimes(1);
  expect(applicationMock).not.toHaveBeenCalled();

  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Bike');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA09');
  await fireEvent.press(screen.getByLabelText('Save vehicle'));
  await act(async () => {});
  expect(await screen.findByTestId('vehicle-saved')).toBeTruthy();
  expect(screen.getByText('Vehicle details saved')).toBeTruthy();
  expect(profileMock).toHaveBeenCalledTimes(1);
  expect(applicationMock).not.toHaveBeenCalled();
});

test('a queued vehicle save never skips a preceding store save or applies a stale pull', async () => {
  const storeGate = deferred<Awaited<ReturnType<typeof riderApi.selectOnboardingStore>>>();
  const readGate = deferred<Awaited<ReturnType<typeof riderApi.application>>>();
  storeSelect.mockReturnValueOnce(storeGate.promise);
  applicationMock.mockReturnValueOnce(readGate.promise);
  profileMock.mockResolvedValueOnce({ updated: true, application: snapshotApp({
    homeStoreId: storeB.id, homeStore: storeB, vehicleType: 'Bike', vehicleNo: 'KA09',
  }) });
  await renderScreen();
  await act(async () => { refreshControlProp('application-scroll').onRefresh?.(); });
  await openPicker();
  await fireEvent.press(screen.getByText('Beta Store'));
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Bike');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'ka09');
  await fireEvent.press(screen.getByLabelText('Save vehicle'));
  expect(screen.getByTestId('store-saving')).toBeTruthy();
  expect(screen.getByLabelText('Saving…')).toBeTruthy();
  expect(storeSelect).toHaveBeenCalledTimes(1);
  expect(profileMock).not.toHaveBeenCalled();
  await act(async () => { storeGate.resolve({ updated: true, application: snapshotApp({ homeStoreId: storeB.id, homeStore: storeB }) }); });
  await act(async () => { readGate.resolve(baselineApp()); });
  expect(screen.getByText('Beta Store')).toBeTruthy();
  expect(screen.getByTestId('vehicle-saved')).toBeTruthy();
  expect(profileMock).toHaveBeenCalledWith('Bike', 'KA09', { signal: expect.anything() });
  expect(applicationMock).toHaveBeenCalledTimes(1);
});

test('legacy void responses reconcile via exactly one scoped application read', async () => {
  applicationMock.mockReset();
  storeSelect.mockResolvedValue(undefined);
  applicationMock.mockResolvedValue(baselineApp({ homeStoreId: 'store-a', homeStore: storeA }));
  await renderScreen();
  expect(applicationMock).not.toHaveBeenCalled();
  await openPicker();
  await fireEvent.press(screen.getByText('Alpha Store'));
  await act(async () => {});
  await screen.findByTestId('store-selected');
  expect(storeSelect).toHaveBeenCalledTimes(1);
  expect(applicationMock).toHaveBeenCalledTimes(1);

  // Vehicle legacy path: one additional scoped read.
  applicationMock.mockResolvedValue(baselineApp({ homeStoreId: 'store-a', homeStore: storeA, vehicleType: 'Bike', vehicleNo: 'KA01' }));
  profileMock.mockResolvedValue(undefined);
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Bike');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA01');
  await fireEvent.press(screen.getByLabelText('Save vehicle'));
  await act(async () => {});
  expect(await screen.findByTestId('vehicle-saved')).toBeTruthy();
  expect(applicationMock).toHaveBeenCalledTimes(2);
});

test('definitive store rejection restores the confirmed store and surfaces one sentence plus retry', async () => {
  const { ApiError } = require('../src/api');
  storeSelect.mockRejectedValueOnce(new ApiError('STORE_NOT_FOUND', 400));
  const app = baselineApp({ homeStoreId: 'store-b', homeStore: storeB });
  await renderScreen(app);
  expect(screen.getByText('Beta Store')).toBeTruthy();
  await openPicker();
  await fireEvent.press(screen.getByText('Alpha Store'));
  await act(async () => {});
  expect(await screen.findByText('That store is no longer available. Choose another store.')).toBeTruthy();
  // Confirmed value restored; optimistic Alpha is gone from the compact card.
  expect(screen.getByText('Beta Store')).toBeTruthy();
  expect(screen.getByLabelText('Retry')).toBeTruthy();
  expect(storeSelect).toHaveBeenCalledWith('store-a', { signal: expect.anything() });
});

test('definitive vehicle rejection keeps the draft and shows INVALID_RIDER_PROFILE message', async () => {
  const { ApiError } = require('../src/api');
  profileMock.mockRejectedValueOnce(new ApiError('INVALID_RIDER_PROFILE', 400));
  await renderScreen(baselineApp({ vehicleType: 'Bike', vehicleNo: 'KA01' }));
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Scooter');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA02');
  await fireEvent.press(screen.getByLabelText('Save vehicle'));
  await act(async () => {});
  expect(await screen.findByText('Check your vehicle details and try again.')).toBeTruthy();
  // Draft retained for retry (inputs still show edited values).
  expect(screen.getByTestId('vehicle-type-input').props.value).toBe('Scooter');
  expect(screen.getByTestId('vehicle-number-input').props.value).toBe('KA02');
  expect(screen.getByLabelText('Retry')).toBeTruthy();
});

test('typed-draft preservation: letters typed during vehicle flight survive confirmation', async () => {
  const gate = deferred<any>();
  profileMock.mockReturnValue(gate.promise);
  await renderScreen(baselineApp({ vehicleType: 'Bike', vehicleNo: 'KA01' }));
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Scooter');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA02');
  await fireEvent.press(screen.getByLabelText('Save vehicle'));
  await act(async () => {});
  // Saving indicator only on the vehicle action.
  expect(screen.getByLabelText('Saving…')).toBeTruthy();
  // Rider keeps typing while the request is in flight.
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Scooter X');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA02Y');

  await act(async () => { gate.resolve({ updated: true, application: snapshotApp({ vehicleType: 'Scooter', vehicleNo: 'KA02' }) }); });
  expect(await screen.findByText('Vehicle details saved')).toBeTruthy();
  // Draft preserved (not overwritten by the attempted snapshot).
  expect(screen.getByTestId('vehicle-type-input').props.value).toBe('Scooter X');
  expect(screen.getByTestId('vehicle-number-input').props.value).toBe('KA02Y');
});

test('vehicle retry sends the original values while preserving newer edits', async () => {
  const pending = deferred<Awaited<ReturnType<typeof riderApi.profile>>>();
  profileMock.mockReturnValueOnce(pending.promise);
  profileMock.mockResolvedValueOnce({
    updated: true, application: snapshotApp({ vehicleType: 'Bike', vehicleNo: 'KA09' }),
  });
  await renderScreen();
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Bike');
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA09');
  await fireEvent.press(screen.getByLabelText('Save vehicle'));
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), 'KA10');
  await act(async () => { pending.reject(new (require('../src/api').ApiError)('NETWORK_ERROR', 0)); });
  expect(await screen.findByText('Couldn’t confirm the save. Tap Retry.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Retry'));
  expect(profileMock).toHaveBeenCalledTimes(2);
  expect(profileMock).toHaveBeenLastCalledWith('Bike', 'KA09', { signal: expect.anything() });
  expect(screen.getByTestId('vehicle-number-input').props.value).toBe('KA10');
  expect(await screen.findByTestId('vehicle-saved')).toBeTruthy();
});

test('timeout reconciles via fresh read, shows unknown message, and retry repeats the same intent', async () => {
  const { ApiError } = require('../src/api');
  storeSelect.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0));
  applicationMock.mockResolvedValue(baselineApp({ homeStoreId: null, homeStore: null }));
  await renderScreen();
  await openPicker();
  await fireEvent.press(screen.getByText('Alpha Store'));
  await act(async () => {});
  expect(await screen.findByText('Couldn’t confirm the save. Tap Retry.')).toBeTruthy();
  expect(applicationMock).toHaveBeenCalledTimes(1);
  // Retry the same intent: second attempt uses the snapshot path with zero extra GETs.
  storeSelect.mockResolvedValueOnce({ updated: true, application: snapshotApp({ homeStoreId: 'store-a', homeStore: storeA }) });
  applicationMock.mockClear();
  await fireEvent.press(screen.getByLabelText('Retry'));
  await act(async () => {});
  expect(await screen.findByTestId('store-selected')).toBeTruthy();
  expect(storeSelect).toHaveBeenCalledTimes(2);
  expect(applicationMock).not.toHaveBeenCalled();
});

test('store lock blocks only the store control; vehicle editing and document selection stay available', async () => {
  const gate = deferred<any>();
  storeSelect.mockReturnValue(gate.promise);
  picker.mockResolvedValue({ canceled: true, assets: null });
  await renderScreen();
  await openPicker();
  await fireEvent.press(screen.getByText('Alpha Store'));
  await act(async () => {});
  expect(screen.getByTestId('store-saving')).toBeTruthy();
  // Store control locked.
  expect(screen.getByLabelText('Change store').props.accessibilityState?.disabled).toBe(true);
  // Vehicle form stays usable: inputs accept edits.
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Bike');
  expect(screen.getByTestId('vehicle-type-input').props.value).toBe('Bike');
  // Document selection stays available (button not disabled).
  expect(screen.getByLabelText('Upload document').props.accessibilityState?.disabled).toBe(false);
  await fireEvent.press(screen.getByLabelText('Upload document'));
  await act(async () => {});
  // Cancelled picker returns to previous state without saving (no commit).
  expect(documentMock).not.toHaveBeenCalled();
  // Resolve the store write to clean up.
  await act(async () => { gate.resolve({ updated: true, application: snapshotApp({ homeStoreId: 'store-a', homeStore: storeA }) }); });
  await screen.findByTestId('store-selected');
});

test('Save vehicle is enabled only when the valid draft differs from confirmed data', async () => {
  await renderScreen(baselineApp({ vehicleType: 'Bike', vehicleNo: 'KA01' }));
  expect(screen.getByLabelText('Save vehicle').props.accessibilityState?.disabled).toBe(true);
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Scooter');
  // Differs from confirmed => enabled.
  expect(screen.getByLabelText('Save vehicle').props.accessibilityState?.disabled).toBe(false);
  await fireEvent.changeText(screen.getByTestId('vehicle-number-input'), '');
  expect(screen.getByLabelText('Save vehicle').props.accessibilityState?.disabled).toBe(true);
});

test('refresh fills pristine vehicle fields and preserves dirty drafts', async () => {
  const fresh = deferred<any>();
  applicationMock.mockReturnValueOnce(fresh.promise);
  await renderScreen(baselineApp({ vehicleType: 'Bike', vehicleNo: 'KA01' }));
  // Rider dirties the type field; number stays pristine.
  await fireEvent.changeText(screen.getByTestId('vehicle-type-input'), 'Scooter');
  let element: Record<string, unknown> | undefined;
  type Node = { props?: Record<string, unknown>; children?: Node[] };
  const stack: Node[] = [screen.toJSON() as Node];
  while (stack.length && !element) {
    const node = stack.pop()!;
    element = node.props?.refreshControl as Record<string, unknown> | undefined;
    if (!element && node.children) stack.push(...node.children);
  }
  const control = (element?.props ?? {}) as Record<string, unknown>;
  const pending = (control.onRefresh as () => Promise<unknown>)();
  await act(async () => { fresh.resolve(baselineApp({ vehicleType: 'Bike', vehicleNo: 'KA99' })); });
  await act(async () => { await pending; });
  // Pristine number follows the server; dirty type is preserved.
  expect(screen.getByTestId('vehicle-type-input').props.value).toBe('Scooter');
  expect(screen.getByTestId('vehicle-number-input').props.value).toBe('KA99');
});

test('picker virtualizes 500 stores outside the main scroll, filters locally, reuses cache, and retries failures', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `store-${i}`, name: i === 0 ? 'Alpha Store' : i === 499 ? 'Zulu Store' : `Store ${i}`, city: i % 2 === 0 ? 'Bengaluru' : 'Mysuru' }));
  storesMock.mockResolvedValue(many);
  await renderScreen();
  // The main scroll never contains the 500 rows before opening the picker.
  expect(screen.queryByText('Zulu Store')).toBeNull();
  expect(screen.queryByTestId('store-list')).toBeNull();
  expect(storesMock).not.toHaveBeenCalled();

  await openPicker();
  expect(storesMock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('store-list')).toBeTruthy();
  // Virtualized list renders a window: first rows visible, last row not yet,
  // and the main scroll holds none of the 500 names (only the compact card).
  expect(screen.getByText('Alpha Store')).toBeTruthy();
  expect(screen.queryByText('Zulu Store')).toBeNull();

  // Local name/city filtering without another fetch.
  await fireEvent.changeText(screen.getByLabelText('Search stores'), 'zulu');
  await act(async () => {});
  expect(screen.getByText('Zulu Store')).toBeTruthy();
  expect(screen.queryByText('Alpha Store')).toBeNull();
  expect(storesMock).toHaveBeenCalledTimes(1);

  // Close and reopen: session cache reused, no extra fetch.
  await fireEvent.press(screen.getByLabelText('Close store picker'));
  await act(async () => {});
  await openChangePicker();
  expect(storesMock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('store-list')).toBeTruthy();
});

test('picker list failure shows Try again inside the modal and keeps the compact card usable', async () => {
  storesMock.mockRejectedValueOnce(new Error('offline'));
  await renderScreen();
  await fireEvent.press(screen.getByLabelText('Choose store'));
  await act(async () => {});
  expect(await screen.findByText('Could not load stores. Please try again.')).toBeTruthy();
  // Main form stays visible behind the modal sheet; close returns without a write.
  await fireEvent.press(screen.getByLabelText('Close store picker'));
  await act(async () => {});
  expect(screen.queryByTestId('store-list')).toBeNull();
  storesMock.mockResolvedValue([storeA, storeB]);
  await openPicker();
  expect(await screen.findByText('Alpha Store')).toBeTruthy();
});

test('document upload shows scoped Preparing, Uploading, Confirming, then Uploaded-Awaiting review with zero GETs on snapshot', async () => {
  applicationMock.mockReset();
  const pickerGate = deferred<any>();
  picker.mockReturnValue(pickerGate.promise);
  const targetGate = deferred<any>();
  documentTargetMock.mockReturnValue(targetGate.promise);
  await renderScreen();
  await fireEvent.press(screen.getByLabelText('Upload document'));
  await act(async () => {});
  expect(screen.getByText('Preparing upload…')).toBeTruthy();
  await act(async () => { pickerGate.resolve({ canceled: false, assets: [{ uri: 'file:///cache/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 512, lastModified: 0 }] }); });
  await act(async () => { targetGate.resolve({ mediaId: 'media-1', url: 'https://storage.test/', fields: { key: 'k' }, expiresAt: '2099-01-01T00:00:00.000Z' }); });
  await act(async () => {});
  // Transfer finished; commit queued — row confirms, then shows uploaded.
  expect(documentMock).toHaveBeenCalledWith('licence', 'media-1', expect.anything());
  expect(await screen.findByText('Uploaded · Awaiting review')).toBeTruthy();
  expect(applicationMock).not.toHaveBeenCalled();
  expect(mockedDelete).toHaveBeenCalled();
});

test('document checklist renders from the projected requiredDocuments (snapshot projection)', async () => {
  // After a rejection/resubmission the server projects the refreshed
  // snapshot through requiredDocuments; the app renders it verbatim.
  await renderScreen(baselineApp({
    status: 'UNDER_REVIEW',
    vehicleType: 'Bike', vehicleNo: 'KA01', homeStoreId: 'store-a', homeStore: storeA,
    requiredDocuments: ['licence', 'vehicle_rc'],
    documents: [
      { id: 'doc-1', type: 'licence', status: 'PENDING', reason: null, createdAt: '2099-01-01T00:00:00.000Z' },
      { id: 'doc-2', type: 'vehicle_rc', status: 'APPROVED', reason: null, createdAt: '2099-01-01T00:00:00.000Z' },
    ],
  }));
  expect(screen.getByTestId('document-status-licence').props.children).toBe('Submitted · Awaiting review');
  expect(screen.getByTestId('document-status-vehicle_rc').props.children).toBe('Approved');
  expect(screen.queryByTestId('document-status-id_proof')).toBeNull();
  expect(screen.queryByLabelText('Upload document')).toBeNull();
});

test('document row maps wrong type, oversize, expired, and confirm failures to canonical retry messages', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/bad.txt', name: 'bad.txt', mimeType: 'text/plain', size: 512, lastModified: 0 }] });
  await renderScreen();
  await fireEvent.press(screen.getByLabelText('Upload document'));
  await act(async () => {});
  expect(await screen.findByText('Choose a JPEG, PNG, or PDF.')).toBeTruthy();
  expect(screen.getByLabelText('Retry')).toBeTruthy();
  expect(documentTargetMock).not.toHaveBeenCalled();

  picker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/big.pdf', name: 'big.pdf', mimeType: 'application/pdf', size: 6 * 1024 * 1024, lastModified: 0 }] });
  (mockedExpoFile as any).mockImplementationOnce(() => ({ size: 6 * 1024 * 1024 }));
  await fireEvent.press(screen.getByLabelText('Retry'));
  await act(async () => {});
  expect(await screen.findByText('Choose a file up to 5 MB.')).toBeTruthy();

  const { ApiError } = require('../src/api');
  picker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 512, lastModified: 0 }] });
  documentTargetMock.mockRejectedValueOnce(new ApiError('UPLOAD_EXPIRED', 410));
  await fireEvent.press(screen.getByLabelText('Retry'));
  await act(async () => {});
  expect(await screen.findByText('The upload expired.')).toBeTruthy();

  // Unreadable file: picker reports no usable size.
  (mockedExpoFile as any).mockImplementationOnce(() => ({ size: 0 }));
  picker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 512, lastModified: 0 }] });
  await fireEvent.press(screen.getByLabelText('Retry'));
  await act(async () => {});
  expect(await screen.findByText('Couldn’t read the file. Choose it again.')).toBeTruthy();

  // A transient storage response leaves the attempt available for reconciliation.
  const { UploadError } = require('../src/api');
  mockedUploadFile
    .mockRejectedValueOnce(new UploadError('network interruption', 'retryable'))
    .mockRejectedValueOnce(new UploadError('network interruption', 'retryable'));
  documentMock.mockRejectedValueOnce(new ApiError('UPLOAD_NOT_RECEIVED', 409));
  picker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 512, lastModified: 0 }] });
  await fireEvent.press(screen.getByLabelText('Retry'));
  await act(async () => {});
  expect(await screen.findByText('Couldn’t upload this file.')).toBeTruthy();

  // Retry confirms the existing media ID before attempting another transfer.
  documentMock.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0));
  applicationMock.mockResolvedValue(baselineApp({ documents: [] }));
  await fireEvent.press(screen.getByLabelText('Retry'));
  await act(async () => {});
  expect(await screen.findByText('Couldn’t confirm the upload.')).toBeTruthy();
  expect(mockedUploadFile).toHaveBeenCalledTimes(2);
});

test('RIDER_STATE_INVALID surfaces one sentence for store and vehicle', async () => {
  const { ApiError } = require('../src/api');
  storeSelect.mockRejectedValueOnce(new ApiError('RIDER_STATE_INVALID', 409));
  await renderScreen();
  await openPicker();
  await fireEvent.press(screen.getByText('Alpha Store'));
  await act(async () => {});
  expect(await screen.findByText('Your application is already under review. Refresh its status.')).toBeTruthy();
});

test('pull-to-refresh keeps form and selection visible while refreshing the application', async () => {
  const fresh = deferred<any>();
  applicationMock.mockReturnValueOnce(fresh.promise);
  await renderScreen(baselineApp({ homeStoreId: 'store-a', homeStore: storeA, vehicleType: 'Bike', vehicleNo: 'KA01' }));
  expect(screen.getByText('Alpha Store')).toBeTruthy();
  expect(screen.getByTestId('vehicle-type-input').props.value).toBe('Bike');
  let element: Record<string, unknown> | undefined;
  type Node = { props?: Record<string, unknown>; children?: Node[] };
  const stack: Node[] = [screen.toJSON() as Node];
  while (stack.length && !element) {
    const node = stack.pop()!;
    element = node.props?.refreshControl as Record<string, unknown> | undefined;
    if (!element && node.children) stack.push(...node.children);
  }
  const control = (element?.props ?? {}) as Record<string, unknown>;
  const pending = (control.onRefresh as () => Promise<unknown>)();
  await act(async () => {});
  // Content retained during the read.
  expect(screen.getByText('Alpha Store')).toBeTruthy();
  expect(screen.getByTestId('vehicle-type-input').props.value).toBe('Bike');
  await act(async () => { fresh.resolve(baselineApp({ homeStoreId: 'store-a', homeStore: storeA, vehicleType: 'Bike', vehicleNo: 'KA01', status: 'UNDER_REVIEW' })); });
  await act(async () => { await pending; });
  expect(screen.queryByText('Your application has been submitted. The decision will appear here.')).toBeTruthy();
});

test('a rejected application shows the reason and lets the partner replace the document', async () => {
  await renderScreen(baselineApp({
    status: 'REJECTED',
    requiredDocuments: ['licence'],
    documents: [{
      id: 'document-1', type: 'licence', status: 'REJECTED',
      reason: 'Upload a sharper image.', createdAt: '2026-01-01T00:00:00Z',
    }],
  }));
  expect(screen.getByText('Changes requested')).toBeTruthy();
  expect(screen.getByText('Upload a sharper image.')).toBeTruthy();
  expect(screen.getByLabelText('Upload replacement')).toBeTruthy();
});

test('Get help prefills a safe ONBOARDING draft and sends only on submit', async () => {
  const { ApiError } = require('../src/api');
  storeSelect.mockRejectedValueOnce(new ApiError('STORE_NOT_FOUND', 400));
  const createTicket = mockedApi.createTicket as jest.Mock;
  await renderScreen();
  await openPicker();
  await fireEvent.press(screen.getByText('Alpha Store'));
  await act(async () => {});
  expect(await screen.findByText('That store is no longer available. Choose another store.')).toBeTruthy();
  const { router } = require('expo-router');
  jest.mocked(router.push).mockClear();
  await fireEvent.press(screen.getByLabelText('Get help with store selection'));
  await act(async () => {});
  // Help now opens the support stack with a prefilled ONBOARDING draft; nothing is sent from here.
  expect(createTicket).not.toHaveBeenCalled();
  expect(jest.mocked(router.push)).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: '/support/index', params: expect.objectContaining({ category: 'ONBOARDING', onboarding: '1' }) }),
  );
  const sent = jest.mocked(router.push).mock.calls[0][0] as { params: { prefill: string } };
  expect(sent.params.prefill).toContain('select store');
});
