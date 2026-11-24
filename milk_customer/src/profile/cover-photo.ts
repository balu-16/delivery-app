import { launchImageLibraryAsync } from 'expo-image-picker';
import { Platform } from 'react-native';
import type { CoverUploadTarget } from '@/src/api/profile-cover';
import { coverMediaUrl } from '@/src/api/profile-cover';
import { apiBaseUrl } from '@/src/api/client';
import {
  CENTERED_CROP,
  coverCropRect,
  MAX_COVER_BYTES,
  MAX_COVER_WIDTH,
  type CoverCrop,
  type ImageSize,
} from './cover-crop';

export type CoverPhoto = ImageSize & { uri: string };

export async function deleteCoverTemp(uri: string) {
  try {
    if (Platform.OS === 'web') {
      if (uri.startsWith('blob:')) URL.revokeObjectURL(uri);
      return;
    }
    const { File } = await import('expo-file-system');
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The file is also in the app's temporary cache.
  }
}

export async function pickCoverPhoto(): Promise<CoverPhoto | null> {
  const result = await launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  try {
    const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
    const context = ImageManipulator.manipulate(asset.uri);
    try {
      // Decode with the correct orientation and bound preview dimensions before cropping.
      if (Math.max(asset.width, asset.height) > 2560) {
        context.resize(asset.width >= asset.height ? { width: 2560 } : { height: 2560 });
      }
      const image = await context.renderAsync();
      try {
        coverCropRect(image, CENTERED_CROP);
        return await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.94 });
      } finally {
        image.release();
      }
    } finally {
      context.release();
    }
  } finally {
    if (Platform.OS === 'web') await deleteCoverTemp(asset.uri);
  }
}

async function coverBlob(uri: string): Promise<Blob> {
  if (Platform.OS === 'web') return (await fetch(uri)).blob();
  const { File } = await import('expo-file-system');
  return new File(uri);
}

export async function prepareCoverUpload(
  photo: CoverPhoto,
  crop: CoverCrop,
): Promise<{ uri: string; data: Blob }> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const rect = coverCropRect(photo, crop);
  const context = ImageManipulator.manipulate(photo.uri).crop(rect);
  if (rect.width > MAX_COVER_WIDTH) context.resize({ width: MAX_COVER_WIDTH });
  try {
    const image = await context.renderAsync();
    try {
      for (const compress of [0.86, 0.66]) {
        const { uri } = await image.saveAsync({ format: SaveFormat.JPEG, compress });
        let keep = false;
        try {
          const data = await coverBlob(uri);
          if (data.size > 0 && data.size <= MAX_COVER_BYTES) {
            keep = true;
            return { uri, data };
          }
        } finally {
          if (!keep) await deleteCoverTemp(uri);
        }
      }
      throw new Error('This cover is too large. Choose a smaller photo and try again.');
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}

export async function uploadCoverPhoto(target: CoverUploadTarget, data: Blob, signal: AbortSignal) {
  const url = coverMediaUrl(target.url);
  const authorization = target.fields.authorization;
  const remaining = Date.parse(target.expiresAt) - Date.now();
  if (authorization && url.origin !== new URL(apiBaseUrl()).origin)
    throw new Error('The upload address is unavailable.');
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('The upload expired. Try again.');

  let body: Blob | FormData = data;
  if (!authorization) {
    const form = new FormData();
    for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
    form.append('file', data, 'profile-cover.jpg');
    body = form;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(60000, remaining));
  try {
    const send = Platform.OS === 'web' ? fetch : (await import('expo/fetch')).fetch;
    const response = await send(url.href, {
      method: authorization ? 'PUT' : 'POST',
      headers: authorization
        ? { Authorization: authorization, 'Content-Type': 'application/octet-stream' }
        : undefined,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Couldn’t upload your cover. Try again.');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
