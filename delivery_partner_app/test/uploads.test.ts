/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile, UploadType } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { ApiError, riderApi, UploadError, uploadFile } from '../src/api';
import { clearAccountTransfers, restoreDocumentUploads, uploadDocument, uploadProof } from '../src/files';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 } }));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', deleteAsync: jest.fn(), makeDirectoryAsync: jest.fn(), moveAsync: jest.fn() }));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn(), getIdToken: jest.fn() }));
jest.mock('../src/apiAddress', () => ({ ...jest.requireActual('../src/apiAddress'), developmentHost: () => null }));

const mockUpload = jest.fn();
const mockTask = jest.fn(() => ({ uploadAsync: mockUpload }));
const target = {
  mediaId: '00000000-0000-4000-8000-000000000001',
  url: 'https://storage.example.test/',
  fields: { key: 'private/key', policy: 'signed-policy', 'Content-Type': 'application/pdf' },
    expiresAt: '2099-01-01T00:00:00.000Z',
};
const document = { uri: 'file:///cache/document.pdf', name: 'document.pdf', mimeType: 'application/pdf', size: 512, lastModified: 0 };
const picker = jest.mocked(DocumentPicker.getDocumentAsync);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:3000';
  jest.mocked(ExpoFile).mockImplementation(() => ({ createUploadTask: mockTask, size: 512 }) as unknown as ExpoFile);
  mockUpload.mockResolvedValue({ status: 204 });
  jest.mocked(FileSystem.deleteAsync).mockResolvedValue(undefined);
  jest.spyOn(riderApi, 'documentTarget').mockResolvedValue(target);
  jest.spyOn(riderApi, 'document').mockResolvedValue(undefined);
  jest.spyOn(riderApi, 'podTarget').mockResolvedValue(target);
  jest.spyOn(riderApi, 'podComplete').mockResolvedValue(undefined);
});

afterEach(async () => {
  await clearAccountTransfers('test-rider');
  jest.restoreAllMocks();
});

const uploadLicence = () => uploadDocument(
  'test-rider', 'licence', 5 * 1024 * 1024,
  async (mediaId) => { await riderApi.document('licence', mediaId); },
  () => {}, () => {},
);

test('native S3 uploads include all signed fields and preserve the selected MIME type', async () => {
  await uploadFile(target, document);
  expect(ExpoFile).toHaveBeenCalledWith(document.uri);
  expect(mockTask).toHaveBeenCalledWith(target.url, expect.objectContaining({
    httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: document.mimeType, parameters: target.fields,
  }));
});

test('local binary upload uses its authorization only for the backend origin', async () => {
  const local = { ...target, url: '/dev/private-media/abc', fields: { authorization: 'Bearer local-token' } };
  await uploadFile(local, document);
  expect(mockTask).toHaveBeenCalledWith('http://localhost:3000/dev/private-media/abc', expect.objectContaining({
    httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT,
    headers: { Authorization: 'Bearer local-token', 'Content-Type': 'application/octet-stream' },
  }));
  await expect(uploadFile({ ...local, url: 'https://other.example.test/' }, document)).rejects.toBeInstanceOf(UploadError);
  expect(mockUpload).toHaveBeenCalledTimes(1);
});

test('upload errors do not expose storage URLs, authorization or local paths', async () => {
  mockUpload.mockRejectedValue(new Error('secret signed URL and local path'));
  await expect(uploadFile(target, document)).rejects.toThrow('Couldn’t upload this file.');
});

test('a document is registered only after its upload succeeds and its cache file is removed', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [document] });
  await expect(uploadLicence()).resolves.toBe(target.mediaId);
  expect(riderApi.documentTarget).toHaveBeenCalledWith('application/pdf', 512, { signal: expect.anything() });
  expect(riderApi.document).toHaveBeenCalledWith('licence', target.mediaId);
  expect(mockUpload.mock.invocationCallOrder[0]!).toBeLessThan(jest.mocked(riderApi.document).mock.invocationCallOrder[0]!);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(expect.stringContaining('partner-uploads/'), { idempotent: true });
});

test('an unsuccessful storage upload never registers a document', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [document] });
  mockUpload.mockResolvedValue({ status: 403 });
  await expect(uploadLicence()).rejects.toBeInstanceOf(UploadError);
  expect(riderApi.document).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
});

test('registration with an uncertain network result reuses the same media ID', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [document] });
  jest.mocked(riderApi.document).mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0));
  await expect(uploadLicence()).rejects.toBeInstanceOf(ApiError);
  await expect(uploadLicence()).resolves.toBe(target.mediaId);
  expect(riderApi.document).toHaveBeenCalledTimes(2);
  expect(riderApi.documentTarget).toHaveBeenCalledTimes(1);
  expect(mockUpload).toHaveBeenCalledTimes(1);
});

test('cancellation, unsupported files and oversized files do not request an upload target', async () => {
  picker.mockResolvedValueOnce({ canceled: true, assets: null });
  await expect(uploadLicence()).resolves.toBeNull();
  picker.mockResolvedValueOnce({ canceled: false, assets: [{ ...document, name: 'bad.txt', mimeType: 'text/plain' }] });
  await expect(uploadLicence()).rejects.toThrow('Choose a JPEG, PNG, or PDF.');
  jest.mocked(ExpoFile).mockImplementationOnce(() => ({ size: 5 * 1024 * 1024 + 1 }) as unknown as ExpoFile);
  picker.mockResolvedValueOnce({ canceled: false, assets: [{ ...document, size: 5 * 1024 * 1024 + 1 }] });
  await expect(uploadLicence()).rejects.toThrow('Choose a file up to 5 MB.');
  expect(riderApi.documentTarget).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
});

test('uses native file metadata if the picker does not provide a size', async () => {
  const { size: _size, ...withoutSize } = document;
  picker.mockResolvedValue({ canceled: false, assets: [withoutSize] });
  await expect(uploadLicence()).resolves.toBe(target.mediaId);
  expect(riderApi.documentTarget).toHaveBeenCalledWith('application/pdf', 512, { signal: expect.anything() });
});

describe('Android file picker', () => {
  const original = Platform.OS;
  const selected = { ...document, uri: 'content://com.android.providers.downloads.documents/document/42' };

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.mocked(ExpoFile).mockImplementation(() => ({ exists: true, createUploadTask: mockTask, size: 512 }) as unknown as ExpoFile);
    picker.mockResolvedValue({ canceled: false, assets: [selected] });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: original });
  });

  test('transfers the granted content URI and leaves the original file untouched', async () => {
    await expect(uploadLicence()).resolves.toBe(target.mediaId);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: false }));
    expect(ExpoFile).toHaveBeenLastCalledWith(selected.uri);
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  test('stages a private copy when the provider does not know the file size', async () => {
    const copy = jest.fn().mockResolvedValue(undefined);
    jest.mocked(ExpoFile).mockImplementation((uri) => ({
      exists: true,
      copy,
      createUploadTask: mockTask,
      size: uri === selected.uri ? 0 : 512,
    }) as unknown as ExpoFile);

    await expect(uploadLicence()).resolves.toBe(target.mediaId);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(riderApi.documentTarget).toHaveBeenCalledWith('application/pdf', 512, { signal: expect.anything() });
    expect(ExpoFile).toHaveBeenLastCalledWith(expect.stringContaining('partner-uploads/'));
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(expect.stringContaining('partner-uploads/'), { idempotent: true });
  });

  test('Retry confirms an old transfer before reopening the picker if S3 has no file', async () => {
    const previousMediaId = '00000000-0000-4000-8000-000000000002';
    await AsyncStorage.setItem('dairydirect.partner.uploads.test-rider', JSON.stringify([
      ['kyc:licence', { mediaId: previousMediaId, createdAt: Date.now() }],
    ]));
    expect(await restoreDocumentUploads('test-rider')).toEqual(['licence']);
    jest.mocked(riderApi.document).mockRejectedValueOnce(new ApiError('UPLOAD_NOT_RECEIVED', 409));

    await expect(uploadLicence()).resolves.toBe(target.mediaId);
    expect(riderApi.document).toHaveBeenNthCalledWith(1, 'licence', previousMediaId);
    expect(riderApi.document).toHaveBeenNthCalledWith(2, 'licence', target.mediaId);
    expect(picker).toHaveBeenCalledTimes(1);
  });
});

test('delivery proof uses the same native upload and completes after upload', async () => {
  const photo = { ...document, uri: 'file:///cache/photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg' };
  picker.mockResolvedValue({ canceled: false, assets: [photo] });
  await expect(uploadProof('task-1', 'test-rider')).resolves.toBe(target.mediaId);
  expect(riderApi.podTarget).toHaveBeenCalledWith('task-1', 'image/jpeg', 512, { signal: expect.anything() });
  expect(riderApi.podComplete).toHaveBeenCalledWith('task-1', target.mediaId, expect.anything());
});

test.each([
  ['readable', false],
  ['blocked by CORS after transfer', true],
] as const)('web confirms the signed form when the response is %s', async (_description, blocked) => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  const fetchMock = jest.fn().mockResolvedValue({ status: 204, ok: true });
  if (blocked) fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const savedFetch = globalThis.fetch;
  const savedBlob = globalThis.Blob;
  const savedFormData = globalThis.FormData;
  class BrowserFormData {
    parts: unknown[][] = [];
    append(...part: unknown[]) { this.parts.push(part); }
  }
  class BrowserBlob {
    type: string;
    size = 512;
    constructor(_parts: unknown[], options?: { type?: string }) { this.type = options?.type ?? ''; }
  }
  globalThis.fetch = fetchMock;
  globalThis.Blob = BrowserBlob as unknown as typeof Blob;
  globalThis.FormData = BrowserFormData as unknown as typeof FormData;
  try {
    const webFile = new Blob(['test'], { type: 'application/pdf' });
    picker.mockResolvedValue({
      canceled: false, assets: [{ ...document, file: webFile as File }],
    });
    await expect(uploadLicence()).resolves.toBe(target.mediaId);
    expect(fetchMock).toHaveBeenCalledWith(target.url, expect.objectContaining({ method: 'POST', body: expect.any(FormData) }));
    const form = fetchMock.mock.calls[0]![1].body as BrowserFormData;
    expect(form.parts.map((part) => part[0])).toEqual(['key', 'policy', 'Content-Type', 'file']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(riderApi.document).toHaveBeenCalledTimes(1);
    expect(riderApi.document).toHaveBeenCalledWith('licence', target.mediaId);
    expect(mockUpload).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.Blob = savedBlob;
    globalThis.FormData = savedFormData;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: original });
  }
});
