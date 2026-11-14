import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { PrivateUploadPort } from '../contracts/uploads.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { documentsApproved, documentsReady } from '../domain/identity-policy.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { assertRiderReviewAccess } from './store-review-access.js';

export class RiderOnboarding {
  constructor(
    private readonly db: Database,
    private readonly uploads: PrivateUploadPort,
    private readonly config: AppConfig,
  ) {}
  async uploadTarget(
    userId: string,
    contentType: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }> {
    return this.uploads.createTarget(userId, 'RIDER_KYC', contentType, size);
  }
  async registerDocument(userId: string, documentType: string, mediaId: string): Promise<void> {
    const required = await this.config.get('requiredRiderDocuments');
    if (!required.includes(documentType)) throw new Error('INVALID_DOCUMENT_TYPE');
    await this.uploads.assertOwnedRegistered(userId, mediaId, 'RIDER_KYC');
    await this.db.transaction().execute(async (tx) => {
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${userId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='RIDER' FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      const profile = await sql<{
        status: string;
      }>`SELECT status FROM rider_profiles WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
      if (!profile.rows[0] || !['PENDING', 'REJECTED'].includes(profile.rows[0].status))
        throw new Error('RIDER_STATE_INVALID');
      await sql`INSERT INTO rider_documents(id,rider_id,document_type,media_id,status) VALUES (${uuidV7()}::uuid,${userId}::uuid,${documentType},${mediaId}::uuid,'PENDING')`.execute(
        tx,
      );
      const types = await sql<{
        document_type: string;
        status: string;
      }>`SELECT DISTINCT ON (document_type) document_type,status FROM rider_documents WHERE rider_id=${userId}::uuid ORDER BY document_type,created_at DESC,id DESC`.execute(
        tx,
      );
      if (documentsReady(required, types.rows))
        await sql`UPDATE rider_profiles SET status='UNDER_REVIEW' WHERE user_id=${userId}::uuid AND vehicle_type IS NOT NULL AND vehicle_no IS NOT NULL AND home_store_id IS NOT NULL`.execute(
          tx,
        );
    });
  }
  async reviewUrl(reviewerId: string, documentId: string): Promise<string> {
    const mediaId = await this.db.transaction().execute(async (tx) => {
      const doc = await sql<{
        media_id: string;
        rider_id: string;
      }>`SELECT media_id,rider_id FROM rider_documents WHERE id=${documentId}::uuid`.execute(tx);
      if (!doc.rows[0] || doc.rows[0].rider_id === reviewerId)
        throw new Error('DOCUMENT_NOT_FOUND');
      await assertRiderReviewAccess(tx, reviewerId, doc.rows[0].rider_id);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${reviewerId}::uuid,'RIDER_DOCUMENT_READ','rider_document',${documentId})`.execute(
        tx,
      );
      return doc.rows[0].media_id;
    });
    return this.uploads.signedRead(mediaId);
  }
  async review(
    reviewerId: string,
    documentId: string,
    approved: boolean,
    reason: string,
  ): Promise<void> {
    const required = await this.config.get('requiredRiderDocuments');
    if (!approved && !reason.trim()) throw new Error('REVIEW_REASON_REQUIRED');
    await this.db.transaction().execute(async (tx) => {
      const owner = await sql<{
        rider_id: string;
      }>`SELECT rider_id FROM rider_documents WHERE id=${documentId}::uuid`.execute(tx);
      if (!owner.rows[0]) throw new Error('DOCUMENT_STATE_INVALID');
      // Serialize reviews with each other and with submissions for this rider.
      await assertRiderReviewAccess(tx, reviewerId, owner.rows[0].rider_id, 'update');
      const profile = await sql<{
        status: string;
      }>`SELECT status FROM rider_profiles WHERE user_id=${owner.rows[0].rider_id}::uuid`.execute(
        tx,
      );
      if (profile.rows[0]?.status !== 'UNDER_REVIEW') throw new Error('DOCUMENT_STATE_INVALID');
      const document = await sql<{
        rider_id: string;
        status: string;
        document_type: string;
      }>`SELECT rider_id,status,document_type FROM rider_documents WHERE id=${documentId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const row = document.rows[0];
      if (!row || row.status !== 'PENDING' || row.rider_id === reviewerId)
        throw new Error('DOCUMENT_STATE_INVALID');
      const latestDocument = await sql<{
        id: string;
      }>`SELECT id FROM rider_documents WHERE rider_id=${row.rider_id}::uuid AND document_type=${row.document_type} ORDER BY created_at DESC,id DESC LIMIT 1`.execute(
        tx,
      );
      if (latestDocument.rows[0]?.id !== documentId) throw new Error('DOCUMENT_STATE_INVALID');
      await sql`UPDATE rider_documents SET status=${approved ? 'APPROVED' : 'REJECTED'},reviewed_by=${reviewerId}::uuid,reason=${reason.trim().slice(0, 500)} WHERE id=${documentId}::uuid`.execute(
        tx,
      );
      const latest = await sql<{
        document_type: string;
        status: string;
      }>`SELECT DISTINCT ON (document_type) document_type,status FROM rider_documents WHERE rider_id=${row.rider_id}::uuid ORDER BY document_type,created_at DESC,id DESC`.execute(
        tx,
      );
      if (!approved)
        await sql`UPDATE rider_profiles SET status='REJECTED' WHERE user_id=${row.rider_id}::uuid AND status='UNDER_REVIEW'`.execute(
          tx,
        );
      else if (documentsApproved(required, latest.rows))
        await sql`UPDATE rider_profiles SET status='APPROVED' WHERE user_id=${row.rider_id}::uuid AND status='UNDER_REVIEW'`.execute(
          tx,
        );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${reviewerId}::uuid,'RIDER_DOCUMENT_REVIEWED','rider_document',${documentId})`.execute(
        tx,
      );
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: approved ? 'rider.document.approved' : 'rider.document.rejected',
          schemaVersion: 1,
          aggregateType: 'rider_document',
          aggregateId: documentId,
          aggregateVersion: '1',
          occurredAt: new Date().toISOString(),
          correlationId: row.rider_id,
          causationId: null,
          payload: {
            documentId,
            riderId: row.rider_id,
            userId: row.rider_id,
            reason: reason.trim().slice(0, 500),
          },
        },
        ['notifications'],
      );
    });
  }
}
