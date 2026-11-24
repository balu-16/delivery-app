import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { ApiError, riderApi, UploadError, uploadFile, type UploadTarget } from './api';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const RECOVERY_MS = 15 * 60_000;
const IMAGES = ['image/jpeg', 'image/png'];
const DOCUMENTS = [...IMAGES, 'application/pdf'];
type FileCopy = { uri: string; name: string; mimeType: string; size: number; webFile?: Blob };
type Recovery = { mediaId: string; createdAt: number };
type Pending = Recovery & { target?: UploadTarget; file?: FileCopy; transferAttempts?: number };
type Phase = 'preparing' | 'uploading' | 'confirming';

const accounts = new Map<string, {
  pending: Map<string, Pending>;
  active: Map<string, AbortController>;
}>();
let pickerOpen = false;
let transferCount = 0;
let cacheSequence = 0;
const cacheDirectory = () => FileSystem.cacheDirectory && `${FileSystem.cacheDirectory}partner-uploads/`;
const recoveryKey = (account: string) => `dairydirect.partner.uploads.${account}`;

async function nextCachePath(directory: string) {
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  return `${directory}${Date.now()}-${++cacheSequence}`;
}

function accountUploads(account: string) {
  let uploads = accounts.get(account);
  if (!uploads) {
    uploads = { pending: new Map(), active: new Map() };
    accounts.set(account, uploads);
  }
  return uploads;
}

async function persist(account: string, pending: Map<string, Pending>) {
  const entries: [string, Recovery][] = [...pending].map(([key, value]) => [
    key, { mediaId: value.mediaId, createdAt: value.createdAt },
  ]);
  const key = recoveryKey(account);
  await (entries.length
    ? AsyncStorage.setItem(key, JSON.stringify(entries))
    : AsyncStorage.removeItem(key)).catch(() => undefined);
}

export async function restoreDocumentUploads(account: string): Promise<string[]> {
  const uploads = accountUploads(account);
  const raw = await AsyncStorage.getItem(recoveryKey(account)).catch(() => null);
  if (accounts.get(account) !== uploads) return [];
  try {
    const entries = raw ? JSON.parse(raw) as [string, Recovery][] : [];
    for (const [key, entry] of entries) {
      if (
        typeof key === 'string' && typeof entry?.mediaId === 'string' &&
        Number.isFinite(entry.createdAt) && Date.now() - entry.createdAt < RECOVERY_MS &&
        !uploads.active.has(key) && !uploads.pending.has(key)
      ) uploads.pending.set(key, entry);
    }
  } catch { /* Malformed recovery metadata cannot be reused. */ }
  return [...uploads.pending.keys()]
    .filter(key => key.startsWith('kyc:') && !uploads.active.has(key))
    .map(key => key.slice(4));
}

async function cleanup(uri: string) {
  if (Platform.OS === 'web') {
    if (uri.startsWith('blob:')) URL.revokeObjectURL(uri);
    return;
  }
  if (FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory))
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

export async function pruneUploadCache() {
  const expired: Promise<void>[] = [];
  for (const [account, uploads] of accounts) {
    let changed = false;
    for (const [slot, pending] of uploads.pending) {
      if (uploads.active.has(slot) || Date.now() - pending.createdAt < RECOVERY_MS) continue;
      uploads.pending.delete(slot);
      if (pending.file) expired.push(cleanup(pending.file.uri));
      changed = true;
    }
    if (changed) expired.push(persist(account, uploads.pending));
  }
  await Promise.all(expired);
  const directory = cacheDirectory();
  if (!directory || Platform.OS === 'web') return;
  const names = await FileSystem.readDirectoryAsync(directory).catch(() => []);
  const retained = new Set([...accounts.values()].flatMap(uploads =>
    [...uploads.pending.values()].map(pending => pending.file?.uri)));
  await Promise.all(names.filter(name => /^\d+-\d+$/.test(name)).map(async name => {
    const uri = directory + name;
    if (!retained.has(uri) && Date.now() - Number(name.split('-')[0]) >= RECOVERY_MS)
      await cleanup(uri);
  }));
}

export async function clearAccountTransfers(account: string) {
  const uploads = accounts.get(account);
  accounts.delete(account);
  uploads?.active.forEach(controller => controller.abort());
  const files = [...(uploads?.pending.values() ?? [])].flatMap(entry => entry.file ? [entry.file.uri] : []);
  await Promise.all([
    ...files.map(cleanup),
    persist(account, new Map()),
  ]);
}

function requireActive(signal: AbortSignal) {
  if (signal.aborted) throw new UploadError('The upload was interrupted.', 'retryable');
}

async function select(allowed: string[], maxBytes: number, signal: AbortSignal): Promise<FileCopy | null> {
  requireActive(signal);
  if (pickerOpen) throw new UploadError('Close the other file picker first.');
  pickerOpen = true;
  let result: DocumentPicker.DocumentPickerResult;
  try {
    result = await DocumentPicker.getDocumentAsync({
      type: allowed,
      multiple: false,
      // Keep Android's picker-granted content URI. Expo Go's picker cache can
      // be outside this experience's readable file-system scope.
      copyToCacheDirectory: Platform.OS !== 'android',
      base64: false,
    });
  } catch {
    throw new UploadError('Could not open the file picker. Please try again.');
  } finally {
    pickerOpen = false;
  }
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  let uri = asset.uri;
  try {
    requireActive(signal);
    const extension = asset.name.toLowerCase().split('.').at(-1);
    const fallback = extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : '';
    const mimeType = asset.mimeType && allowed.includes(asset.mimeType) ? asset.mimeType : fallback;
    if (!allowed.includes(mimeType))
      throw new UploadError(allowed === DOCUMENTS ? 'Choose a JPEG, PNG, or PDF.' : 'Choose a JPEG or PNG image.');
    let webFile = Platform.OS === 'web' ? asset.file : undefined;
    if (Platform.OS === 'web' && !webFile) {
      const response = await fetch(uri, { signal });
      if (!response.ok) throw new Error('Cannot read selected file');
      const blob = await response.blob();
      webFile = new File([blob], asset.name, { type: mimeType });
    }
    const nativeFile = Platform.OS === 'web' ? undefined : new ExpoFile(uri);
    if (Platform.OS === 'android' && !nativeFile?.exists)
      throw new UploadError('Couldn’t read the file. Choose it again.');
    const directory = cacheDirectory();
    let size = nativeFile?.size ?? webFile?.size;
    // Some Android providers return no size. Measure a private cache copy so
    // the upload policy can still require the exact byte count.
    if (Platform.OS === 'android' && nativeFile && uri.startsWith('content://') && size === 0 && directory) {
      uri = await nextCachePath(directory);
      const copy = new ExpoFile(uri);
      await nativeFile.copy(copy);
      size = copy.size;
    }
    if (!Number.isSafeInteger(size) || !size || size < 1)
      throw new UploadError('Couldn’t read the file. Choose it again.');
    const limitMb = Math.round(maxBytes / (1024 * 1024) * 10) / 10;
    if (size > maxBytes) throw new UploadError(`Choose a file up to ${limitMb} MB.`);
    if (Platform.OS !== 'web' && uri === asset.uri && directory && FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory)) {
      const destination = await nextCachePath(directory);
      await FileSystem.moveAsync({ from: uri, to: destination });
      uri = destination;
    }
    requireActive(signal);
    return { uri, name: asset.name, mimeType, size, webFile };
  } catch (error) {
    await cleanup(uri);
    if (error instanceof UploadError) throw error;
    throw new UploadError('Couldn’t read the file. Choose it again.');
  }
}

function codeOf(error: unknown) {
  return error instanceof ApiError ? error.code : undefined;
}

async function runUpload(options: {
  account: string;
  slot: string;
  allowed: string[];
  maxBytes: number;
  target: (mime: string, size: number, signal: AbortSignal) => Promise<UploadTarget>;
  commit: (id: string, signal: AbortSignal) => Promise<void>;
  onPhase?: (phase: Phase) => void;
  onProgress?: (progress: number) => void;
}): Promise<string | null> {
  const uploads = accountUploads(options.account);
  if (uploads.active.has(options.slot)) return null;
  const controller = new AbortController();
  const { signal } = controller;
  uploads.active.set(options.slot, controller);
  let pending = uploads.pending.get(options.slot);
  let picked: FileCopy | undefined;

  const forget = async () => {
    if (accounts.get(options.account) !== uploads) return;
    uploads.pending.delete(options.slot);
    await persist(options.account, uploads.pending);
  };
  const confirm = async (entry: Pending) => {
    requireActive(signal);
    options.onPhase?.('confirming');
    await options.commit(entry.mediaId, signal);
    requireActive(signal);
  };
  const send = async (entry: Pending) => {
    requireActive(signal);
    if (transferCount >= 2) throw new UploadError('Two files are uploading. Tap Retry in a moment.', 'busy');
    if (!entry.target || !entry.file) throw new UploadError('The file wasn’t received. Pick it again.');
    transferCount += 1;
    entry.transferAttempts = (entry.transferAttempts ?? 0) + 1;
    options.onPhase?.('uploading');
    try { await uploadFile(entry.target, entry.file, { signal, onProgress: options.onProgress }); }
    finally { transferCount -= 1; }
  };
  const reconcile = async (entry: Pending) => {
    try { await confirm(entry); }
    catch (error) {
      const code = codeOf(error);
      const missing = code === 'UPLOAD_NOT_RECEIVED' || (options.slot.startsWith('pod:') && code === 'MEDIA_NOT_FOUND');
      if (!missing) throw error;
      const canSend = entry.file && entry.target && (entry.transferAttempts ?? 0) < 2
        && (!entry.target.expiresAt || Date.parse(entry.target.expiresAt) > Date.now());
      if (!canSend) return false;
      await send(entry);
      await confirm(entry);
    }
    return true;
  };

  try {
    if (pending && Date.now() - pending.createdAt >= RECOVERY_MS) {
      if (pending.file) await cleanup(pending.file.uri);
      await forget();
      pending = undefined;
    }
    if (pending) {
      if (await reconcile(pending)) {
        await forget();
        return pending.mediaId;
      }
      const previousFile = pending.file;
      await forget();
      pending = undefined;
      if (previousFile) await cleanup(previousFile.uri);
      // The browser needs a fresh user gesture to reopen its file chooser.
      if (Platform.OS === 'web') throw new UploadError('The file wasn’t received. Pick it again.');
    }
    options.onPhase?.('preparing');
    picked = (await select(options.allowed, options.maxBytes, signal)) ?? undefined;
    if (!picked) return null;
    requireActive(signal);
    const target = await options.target(picked.mimeType, picked.size, signal);
    requireActive(signal);
    pending = { mediaId: target.mediaId, target, file: picked, createdAt: Date.now() };
    uploads.pending.set(options.slot, pending);
    await persist(options.account, uploads.pending);
    try {
      await send(pending);
    } catch (error) {
      if (!(error instanceof UploadError) || error.kind !== 'retryable' || !await reconcile(pending))
        throw error;
      await forget();
      return pending.mediaId;
    }
    await confirm(pending);
    await forget();
    return pending.mediaId;
  } catch (error) {
    const definitive = error instanceof UploadError && (error.kind === 'rejected' || error.kind === 'expired')
      || ['UPLOAD_EXPIRED', 'UPLOAD_NOT_RECEIVED', 'MEDIA_NOT_FOUND', 'INVALID_MEDIA', 'RESOURCE_NOT_FOUND',
        'RIDER_STATE_INVALID', 'FORBIDDEN', 'INVALID_DOCUMENT_TYPE'].includes(codeOf(error) ?? '');
    if (definitive) await forget();
    throw error;
  } finally {
    uploads.active.delete(options.slot);
    const file = picked ?? pending?.file;
    if (file && (signal.aborted || !uploads.pending.has(options.slot))) await cleanup(file.uri);
  }
}

export function uploadDocument(
  account: string,
  type: string,
  maxBytes: number,
  commit: (mediaId: string, signal: AbortSignal) => Promise<void>,
  onPhase: (phase: Phase) => void,
  onProgress: (progress: number) => void,
) {
  return runUpload({
    account, slot: `kyc:${type}`, allowed: DOCUMENTS, maxBytes, onPhase, onProgress,
    target: (mime, size, signal) => riderApi.documentTarget(mime, size, { signal }),
    commit,
  });
}

export function uploadProof(taskId: string, account: string) {
  return runUpload({
    account, slot: `pod:${taskId}`, allowed: IMAGES, maxBytes: DEFAULT_MAX_BYTES,
    target: (mime, size, signal) => riderApi.podTarget(taskId, mime, size, { signal }),
    commit: (mediaId, signal) => riderApi.podComplete(taskId, mediaId, signal),
  });
}
