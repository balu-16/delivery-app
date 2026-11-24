import type { TransactionContext } from '../../../platform/database/database.js';
import type { RiderApplicationView } from './rider-applications.js';
export type PrivateMediaPurpose =
  | 'RIDER_KYC'
  | 'DELIVERY_POD'
  | 'SUPPORT_ATTACHMENT'
  | 'PAYOUT_EVIDENCE'
  | 'CUSTOMER_PROFILE_COVER';
export interface PrivateUploadTarget {
  mediaId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}
export interface PreparedPrivateUpload {
  commit(tx: TransactionContext): Promise<void>;
  release(): Promise<void>;
}
export interface PrivateUploadPort {
  createTarget(
    ownerId: string,
    purpose: PrivateMediaPurpose,
    contentType: string,
    size: number,
  ): Promise<PrivateUploadTarget>;
  assertOwnedRegistered(
    ownerId: string,
    mediaId: string,
    purpose: PrivateMediaPurpose,
  ): Promise<void>;
  /** A cover read also requires the owner and a current profile reference. */
  signedRead(mediaId: string, coverOwnerId?: string): Promise<string>;
  /** Verify the object and bind the commit and release to this media and lease. */
  prepareOwnedUpload(
    ownerId: string,
    mediaId: string,
    purpose: PrivateMediaPurpose,
  ): Promise<PreparedPrivateUpload>;
}
/** Server-only cleanup capability; never exposed as an upload operation. */
export interface PrivateMediaErasure {
  fenceForErasure(userId: string, tx: TransactionContext): Promise<void>;
  eraseFenced(userId: string): Promise<boolean>;
}
export const PRIVATE_UPLOADS = Symbol('PRIVATE_UPLOADS');

/**
 * Server-derived reviewer scope. Controllers construct this from the
 * authenticated principal, never from client input. The transaction
 * rechecks the role and any store assignment before deciding.
 */
export type RiderReviewerScope = { role: 'SUPER_ADMIN' | 'STORE_MANAGER' };

export interface RiderDocuments {
  uploadTarget(userId: string, contentType: string, size: number): Promise<PrivateUploadTarget>;
  registerDocument(
    userId: string,
    documentType: string,
    mediaId: string,
  ): Promise<RiderApplicationView>;
  reviewUrl(reviewerId: string, documentId: string, scope: RiderReviewerScope): Promise<string>;
  review(
    reviewerId: string,
    documentId: string,
    approved: boolean,
    reason: string,
    scope: RiderReviewerScope,
  ): Promise<void>;
}
export const RIDER_DOCUMENTS = Symbol('RIDER_DOCUMENTS');
