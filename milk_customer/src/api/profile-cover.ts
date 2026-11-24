import type { components } from './customer.generated';
import { apiBaseUrl, customerRequest } from './client';

export type ProfileCover = components['schemas']['ProfileCoverView'];
export type CoverSelection = Omit<components['schemas']['CoverSelectionDto'], 'expectedVersion'>;
export type CoverUploadTarget = components['schemas']['UploadTargetResponseDto'];

const path = '/v1/customer/me/cover';

export const profileCoverApi = {
  get: (token: string, signal?: AbortSignal) => customerRequest<ProfileCover>(path, { token, signal }),
  save: (token: string, selection: CoverSelection, expectedVersion: string, signal?: AbortSignal) =>
    customerRequest<ProfileCover>(path, {
      method: 'PUT',
      token,
      body: { ...selection, expectedVersion },
      signal,
      timeoutMs: 45000,
    }),
  target: (token: string, size: number, signal?: AbortSignal) =>
    customerRequest<CoverUploadTarget>(`${path}/upload-target`, {
      method: 'POST',
      token,
      body: { size },
      signal,
    }),
};

export function coverMediaUrl(value: string): URL {
  const base = new URL(apiBaseUrl());
  const url = new URL(value, base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(__DEV__ && url.origin === base.origin))
  ) {
    throw new Error('The cover image address is unavailable.');
  }
  return url;
}
