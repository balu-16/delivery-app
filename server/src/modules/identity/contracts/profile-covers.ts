import type { PrivateUploadTarget } from './uploads.js';

export const PROFILE_COVER_PURPOSE = 'CUSTOMER_PROFILE_COVER';
export const PROFILE_COVER_MAX_BYTES = 2 * 1024 * 1024;
export const PROFILE_COVER_PRESETS = ['calf-at-sunrise', 'farm-meadow'] as const;
export type CoverPreset = (typeof PROFILE_COVER_PRESETS)[number];

export type CoverSelection =
  | { kind: 'default'; presetId?: never; mediaId?: never }
  | { kind: 'preset'; presetId: CoverPreset; mediaId?: never }
  | { kind: 'photo'; presetId?: never; mediaId: string };

export type ProfileCover = CoverSelection & { version: string; imageUrl: string | null };

export interface ProfileCovers {
  get(userId: string): Promise<ProfileCover>;
  update(userId: string, selection: CoverSelection, expectedVersion: string): Promise<ProfileCover>;
  uploadTarget(userId: string, size: number): Promise<PrivateUploadTarget>;
}

export const PROFILE_COVERS = Symbol('PROFILE_COVERS');
