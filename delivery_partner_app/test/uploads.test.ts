/// <reference types="jest" />
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile, UploadType } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { ApiError, riderApi, UploadError, uploadFile } from '../src/api';
import { uploadDocument, uploadProof } from '../src/files';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 } }));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', deleteAsync: jest.fn() }));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn(), getIdToken: jest.fn() }));
jest.mock('../src/apiAddress', () => ({ ...jest.requireActual('../src/apiAddress'), developmentHost: () => null }));

const mockUpload = jest.fn();
const target = {
  mediaId: '00000000-0000-4000-8000-000000000001',
  url: 'https://storage.example.test/',
  fields: { key: 'private/key', policy: 'signed-policy', 'Content-Type': 'application/pdf' },
};
const document = { uri: 'file:///cache/document.pdf', name: 'document.pdf', mimeType: 'application/pdf', size: 512, lastModified: 0 };
const picker = jest.mocked(DocumentPicker.getDocumentAsync);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:3000';
  jest.mocked(ExpoFile).mockImplementation(() => ({ upload: mockUpload, size: 512 }) as unknown as ExpoFile);
  mockUpload.mockResolvedValue({ status: 204 });
  jest.mocked(FileSystem.deleteAsync).mockResolvedValue(undefined);
  jest.spyOn(riderApi, 'documentTarget').mockResolvedValue(target);
  jest.spyOn(riderApi, 'document').mockResolvedValue(undefined);
  jest.spyOn(riderApi, 'podTarget').mockResolvedValue(target);
  jest.spyOn(riderApi, 'podComplete').mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

test('native S3 uploads include all signed fields and preserve the selected MIME type', async () => {
  await uploadFile(target, document);
  expect(ExpoFile).toHaveBeenCalledWith(document.uri);
  expect(mockUpload).toHaveBeenCalledWith(target.url, {
    httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: document.mimeType, parameters: target.fields,
  });
});

test('local binary upload uses its authorization only for the backend origin', async () => {
  const local = { ...target, url: '/dev/private-media/abc', fields: { authorization: 'Bearer local-token' } };
  await uploadFile(local, document);
  expect(mockUpload).toHaveBeenCalledWith('http://localhost:3000/dev/private-media/abc', {
    httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT,
    headers: { Authorization: 'Bearer local-token', 'Content-Type': 'application/octet-stream' },
  });
  await expect(uploadFile({ ...local, url: 'https://other.example.test/' }, document)).rejects.toBeInstanceOf(UploadError);
  expect(mockUpload).toHaveBeenCalledTimes(1);
});

test('upload errors do not expose storage URLs, authorization or local paths', async () => {
  mockUpload.mockRejectedValue(new Error('secret signed URL and local path'));
  await expect(uploadFile(target, document)).rejects.toThrow('Could not upload the file. Check your connection and try again.');
});

test('a document is registered only after its upload succeeds and its cache file is removed', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [document] });
  await expect(uploadDocument('licence')).resolves.toBe(true);
  expect(riderApi.documentTarget).toHaveBeenCalledWith('application/pdf', 512);
  expect(riderApi.document).toHaveBeenCalledWith('licence', target.mediaId);
  expect(mockUpload.mock.invocationCallOrder[0]!).toBeLessThan(jest.mocked(riderApi.document).mock.invocationCallOrder[0]!);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(document.uri, { idempotent: true });
});

test('an unsuccessful storage upload never registers a document', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [document] });
  mockUpload.mockResolvedValue({ status: 403 });
  await expect(uploadDocument('licence')).rejects.toBeInstanceOf(UploadError);
  expect(riderApi.document).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
});

test('registration with an uncertain network result asks the user to refresh', async () => {
  picker.mockResolvedValue({ canceled: false, assets: [document] });
  jest.mocked(riderApi.document).mockRejectedValue(new ApiError('NETWORK_ERROR', 0));
  await expect(uploadDocument('licence')).rejects.toThrow('Refresh your status before trying again.');
});

test('cancellation, unsupported files and oversized files do not request an upload target', async () => {
  picker.mockResolvedValueOnce({ canceled: true, assets: null });
  await expect(uploadDocument('licence')).resolves.toBe(false);
  picker.mockResolvedValueOnce({ canceled: false, assets: [{ ...document, name: 'bad.txt', mimeType: 'text/plain' }] });
  await expect(uploadDocument('licence')).rejects.toThrow('Choose a JPEG, PNG, or PDF file.');
  jest.mocked(ExpoFile).mockImplementationOnce(() => ({ size: 5 * 1024 * 1024 + 1 }) as unknown as ExpoFile);
  picker.mockResolvedValueOnce({ canceled: false, assets: [{ ...document, size: 5 * 1024 * 1024 + 1 }] });
  await expect(uploadDocument('licence')).rejects.toThrow('5 MB or smaller');
  expect(riderApi.documentTarget).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
});

test('uses native file metadata if the picker does not provide a size', async () => {
  const { size: _size, ...withoutSize } = document;
  picker.mockResolvedValue({ canceled: false, assets: [withoutSize] });
  await expect(uploadDocument('licence')).resolves.toBe(true);
  expect(riderApi.documentTarget).toHaveBeenCalledWith('application/pdf', 512);
});

test('delivery proof uses the same native upload and completes after upload', async () => {
  const photo = { ...document, uri: 'file:///cache/photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg' };
  picker.mockResolvedValue({ canceled: false, assets: [photo] });
  await expect(uploadProof('task-1')).resolves.toBe(target.mediaId);
  expect(riderApi.podTarget).toHaveBeenCalledWith('task-1', 'image/jpeg', 512);
  expect(riderApi.podComplete).toHaveBeenCalledWith('task-1', target.mediaId);
});

test('web uses a browser Blob and preserves signed fields', async () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  const fetchMock = jest.fn().mockResolvedValue({ status: 204, ok: true });
  const savedFetch = globalThis.fetch;
  const savedBlob = globalThis.Blob;
  const savedFormData = globalThis.FormData;
  class BrowserFormData {
    parts: unknown[][] = [];
    append(...part: unknown[]) { this.parts.push(part); }
  }
  class BrowserBlob {
    type: string;
    constructor(_parts: unknown[], options?: { type?: string }) { this.type = options?.type ?? ''; }
  }
  globalThis.fetch = fetchMock;
  globalThis.Blob = BrowserBlob as unknown as typeof Blob;
  globalThis.FormData = BrowserFormData as unknown as typeof FormData;
  try {
    const webFile = new Blob(['test'], { type: 'application/pdf' });
    expect(() => new Blob([webFile], { type: 'application/pdf' })).not.toThrow();
    await uploadFile(target, { ...document, uri: 'blob:test', webFile });
    expect(fetchMock).toHaveBeenCalledWith(target.url, expect.objectContaining({ method: 'POST', body: expect.any(FormData) }));
    const form = fetchMock.mock.calls[0]![1].body as BrowserFormData;
    expect(form.parts.map((part) => part[0])).toEqual(['key', 'policy', 'Content-Type', 'file']);
    expect(mockUpload).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.Blob = savedBlob;
    globalThis.FormData = savedFormData;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: original });
  }
});
