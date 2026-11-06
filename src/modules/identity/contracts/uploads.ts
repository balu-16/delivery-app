export interface PrivateUploadPort {
  createTarget(
    ownerId: string,
    purpose: 'RIDER_KYC',
    contentType: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }>;
  assertOwnedRegistered(ownerId: string, mediaId: string, purpose: 'RIDER_KYC'): Promise<void>;
  signedRead(mediaId: string): Promise<string>;
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
