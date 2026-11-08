import type { TransactionContext } from '../../../platform/database/database.js';
export type PrivateMediaPurpose =
  'RIDER_KYC' | 'DELIVERY_POD' | 'SUPPORT_ATTACHMENT' | 'PAYOUT_EVIDENCE';
export interface PrivateUploadPort {
  createTarget(
    ownerId: string,
    purpose: PrivateMediaPurpose,
    contentType: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }>;
  assertOwnedRegistered(
    ownerId: string,
    mediaId: string,
    purpose: PrivateMediaPurpose,
  ): Promise<void>;
  signedRead(mediaId: string): Promise<string>;
}
/** Server-only cleanup capability; never exposed as an upload operation. */
export interface PrivateMediaErasure {
  fenceForErasure(userId: string, tx: TransactionContext): Promise<void>;
  eraseFenced(userId: string): Promise<boolean>;
}
export const PRIVATE_UPLOADS = Symbol('PRIVATE_UPLOADS');

export interface RiderDocuments {
  uploadTarget(
    userId: string,
    contentType: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }>;
  registerDocument(userId: string, documentType: string, mediaId: string): Promise<void>;
  reviewUrl(reviewerId: string, documentId: string): Promise<string>;
  review(reviewerId: string, documentId: string, approved: boolean, reason: string): Promise<void>;
}
export const RIDER_DOCUMENTS = Symbol('RIDER_DOCUMENTS');
