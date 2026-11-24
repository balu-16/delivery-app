import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type {
  PrivateUploadPort,
  PrivateUploadTarget,
  RiderReviewerScope,
} from '../contracts/uploads.js';
import type { RiderApplicationView } from '../contracts/rider-applications.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { documentsApproved, documentsReady } from '../domain/identity-policy.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { assertScopedRiderReviewAccess } from './store-review-access.js';
import {
  effectiveRequiredDocuments,
  maybeAdvanceRiderReview,
  readRiderApplication,
  requireActiveRider,
} from './rider-application-reader.js';

export class RiderOnboarding {
  constructor(
    private readonly db: Database,
    private readonly uploads: PrivateUploadPort,
    private readonly config: AppConfig,
    private readonly metrics?: { observeStage(stage: string, ms: number): void },
  ) {}
  private record(name: string, start: number) {
    try {
      this.metrics?.observeStage(name, performance.now() - start);
    } catch {
      /* metrics are best effort */
    }
  }
  async uploadTarget(
    userId: string,
    contentType: string,
    size: number,
  ): Promise<PrivateUploadTarget> {
    const start = performance.now();
    const target = await this.uploads.createTarget(userId, 'RIDER_KYC', contentType, size);
    this.record('rider_upload_target', start);
    return target;
  }
  async registerDocument(
    userId: string,
    documentType: string,
    mediaId: string,
  ): Promise<RiderApplicationView> {
    const overallStart = performance.now();
    const required = await this.config.get('requiredRiderDocuments');
    if (!required.includes(documentType)) throw new Error('INVALID_DOCUMENT_TYPE');
    const prepareStart = performance.now();
    const prepared = await this.uploads.prepareOwnedUpload(userId, mediaId, 'RIDER_KYC');
    this.record('rider_upload_prepare', prepareStart);
    const finalizeStart = performance.now();
    try {
      const result = await this.db.transaction().execute(async (tx) => {
        await requireActiveRider(tx, userId);
        const profile = await sql<{
          status: string;
        }>`SELECT status FROM rider_profiles WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
        if (!profile.rows[0]) throw new Error('RIDER_STATE_INVALID');
        const attached = await sql<{ document_type: string }>`
          SELECT document_type FROM rider_documents
          WHERE rider_id=${userId}::uuid AND media_id=${mediaId}::uuid LIMIT 1`.execute(tx);
        if (attached.rows[0]) {
          if (attached.rows[0].document_type !== documentType) throw new Error('FORBIDDEN');
          await prepared.commit(tx);
          return readRiderApplication(tx, userId, required);
        }
        if (!['PENDING', 'REJECTED'].includes(profile.rows[0].status))
          throw new Error('RIDER_STATE_INVALID');
        await prepared.commit(tx);
        await sql`INSERT INTO rider_documents(id,rider_id,document_type,media_id,status) VALUES (${uuidV7()}::uuid,${userId}::uuid,${documentType},${mediaId}::uuid,'PENDING')`.execute(
          tx,
        );
        await maybeAdvanceRiderReview(tx, userId, required);
        return readRiderApplication(tx, userId, required);
      });
      this.record('rider_upload_finalize', finalizeStart);
      return result;
    } catch (error) {
      await prepared.release().catch(() => undefined);
      throw error;
    } finally {
      this.record('rider_upload_register', overallStart);
    }
  }
  async reviewUrl(
    reviewerId: string,
    documentId: string,
    scope: RiderReviewerScope,
  ): Promise<string> {
    const mediaId = await this.db.transaction().execute(async (tx) => {
      const doc = await sql<{
        media_id: string;
        rider_id: string;
      }>`SELECT media_id,rider_id FROM rider_documents WHERE id=${documentId}::uuid`.execute(tx);
      if (!doc.rows[0] || doc.rows[0].rider_id === reviewerId)
        throw new Error('DOCUMENT_NOT_FOUND');
      await assertScopedRiderReviewAccess(tx, reviewerId, doc.rows[0].rider_id, scope);
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
    scope: RiderReviewerScope,
  ): Promise<void> {
    const liveRequired = await this.config.get('requiredRiderDocuments');
    if (!approved && !reason.trim()) throw new Error('REVIEW_REASON_REQUIRED');
    await this.db.transaction().execute(async (tx) => {
      const owner = await sql<{
        rider_id: string;
      }>`SELECT rider_id FROM rider_documents WHERE id=${documentId}::uuid`.execute(tx);
      if (!owner.rows[0]) throw new Error('DOCUMENT_STATE_INVALID');
      // Serialize reviews with each other and with submissions for this rider.
      await assertScopedRiderReviewAccess(tx, reviewerId, owner.rows[0].rider_id, scope, 'update');
      const profile = await sql<{
        status: string;
        review_required_documents: string[] | null;
        complete_details: boolean;
      }>`SELECT status,review_required_documents,
        home_store_id IS NOT NULL AND COALESCE(btrim(vehicle_type),'') <> ''
          AND COALESCE(btrim(vehicle_no),'') <> '' AS complete_details
        FROM rider_profiles WHERE user_id=${owner.rows[0].rider_id}::uuid`.execute(tx);
      if (profile.rows[0]?.status !== 'UNDER_REVIEW' || !profile.rows[0].complete_details)
        throw new Error('DOCUMENT_STATE_INVALID');
      // Review against the snapshot taken when the application entered
      // UNDER_REVIEW; the live config is only the fallback for rows that
      // predate the snapshot column (pre-backfill).
      const required = effectiveRequiredDocuments(
        profile.rows[0].status,
        profile.rows[0].review_required_documents,
        liveRequired,
      );
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
      const latest = await sql<{
        id: string;
        document_type: string;
        status: string;
      }>`SELECT DISTINCT ON (document_type) id,document_type,status
        FROM rider_documents WHERE rider_id=${row.rider_id}::uuid
        ORDER BY document_type,created_at DESC,id DESC`.execute(tx);
      const latestDocument = latest.rows.find((doc) => doc.document_type === row.document_type);
      if (latestDocument?.id !== documentId || !documentsReady(required, latest.rows))
        throw new Error('DOCUMENT_STATE_INVALID');
      latestDocument.status = approved ? 'APPROVED' : 'REJECTED';
      await sql`UPDATE rider_documents SET status=${latestDocument.status},reviewed_by=${reviewerId}::uuid,reason=${reason.trim().slice(0, 500)} WHERE id=${documentId}::uuid`.execute(
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
