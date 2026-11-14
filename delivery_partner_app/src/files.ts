import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { ApiError, riderApi, UploadError, uploadFile } from './api';

// Matches the backend's current private-upload limit.
const MAX_PRIVATE_UPLOAD_BYTES = 5 * 1024 * 1024;

async function select(allowed: string[]) {
  let result: DocumentPicker.DocumentPickerResult;
  try { result = await DocumentPicker.getDocumentAsync({ type: allowed, multiple: false, copyToCacheDirectory: true, base64: false }); }
  catch { throw new UploadError('Could not open the file picker. Please try again.'); }
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  try {
    const extension = asset.name.toLowerCase().split('.').at(-1);
    const mimeType = asset.mimeType && allowed.includes(asset.mimeType) ? asset.mimeType
      : extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : '';
    if (!allowed.includes(mimeType)) throw new UploadError(allowed.includes('application/pdf') ? 'Choose a JPEG, PNG, or PDF file.' : 'Choose a JPEG or PNG image.');
    let webFile: Blob | undefined = Platform.OS === 'web' ? asset.file : undefined;
    if (!webFile && Platform.OS === 'web') {
      const response = await fetch(asset.uri);
      if (!response.ok) throw new Error('Cannot read selected file');
      webFile = await response.blob();
    }
    // The S3 signature requires the size of the actual cached file, not an estimate from its provider.
    const size = Platform.OS === 'web' ? webFile?.size : new ExpoFile(asset.uri).size;
    if (!Number.isSafeInteger(size) || !size || size < 1) throw new UploadError('Could not read the selected file. Please choose it again.');
    if (size > MAX_PRIVATE_UPLOAD_BYTES) throw new UploadError('Choose a file that is 5 MB or smaller.');
    return { uri: asset.uri, name: asset.name, mimeType, size, webFile };
  } catch (error) {
    await cleanup(asset.uri);
    if (error instanceof UploadError) throw error;
    throw new UploadError('Could not read the selected file. Please choose it again.');
  }
}

async function cleanup(uri: string) {
  if (Platform.OS === 'web' && uri.startsWith('blob:')) URL.revokeObjectURL(uri);
  if (Platform.OS !== 'web' && FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory))
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

export async function uploadDocument(type: string): Promise<boolean> {
  const file = await select(['image/jpeg', 'image/png', 'application/pdf']);
  if (!file) return false;
  try {
    const target = await riderApi.documentTarget(file.mimeType, file.size);
    await uploadFile(target, file);
    try { await riderApi.document(type, target.mediaId); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'NETWORK_ERROR')
        throw new UploadError('Could not confirm the upload. Refresh your status before trying again.');
      throw error;
    }
    return true;
  } finally { await cleanup(file.uri); }
}

export async function uploadProof(taskId: string): Promise<string | null> {
  const file = await select(['image/jpeg', 'image/png']);
  if (!file) return null;
  try {
    const target = await riderApi.podTarget(taskId, file.mimeType, file.size);
    await uploadFile(target, file);
    await riderApi.podComplete(taskId, target.mediaId);
    return target.mediaId;
  } finally { await cleanup(file.uri); }
}
