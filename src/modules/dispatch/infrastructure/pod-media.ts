import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { PrivateUploadPort } from '../../identity/contracts/uploads.js';

export class DeliveryPodMedia {
  constructor(
    private readonly db: Database,
    private readonly uploads: PrivateUploadPort,
  ) {}
  private async owns(riderId: string, taskId: string): Promise<void> {
    const task =
      await sql`SELECT 1 FROM delivery_tasks WHERE id=${taskId}::uuid AND rider_id=${riderId}::uuid AND status IN ('PICKED_UP','ARRIVED')`.execute(
        this.db,
      );
    if (!task.rows.length) throw new Error('RESOURCE_NOT_FOUND');
  }
  async target(riderId: string, taskId: string, contentType: string, size: number) {
    await this.owns(riderId, taskId);
    if (!['image/jpeg', 'image/png'].includes(contentType)) throw new Error('INVALID_MEDIA');
    const target = await this.uploads.createTarget(riderId, 'DELIVERY_POD', contentType, size);
    const inserted =
      await sql`INSERT INTO delivery_pod_media(media_id,task_id,rider_id) SELECT ${target.mediaId}::uuid,id,${riderId}::uuid FROM delivery_tasks WHERE id=${taskId}::uuid AND rider_id=${riderId}::uuid AND status IN ('PICKED_UP','ARRIVED') RETURNING media_id`.execute(
        this.db,
      );
    if (!inserted.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    return target;
  }
  async complete(riderId: string, taskId: string, mediaId: string): Promise<void> {
    await this.owns(riderId, taskId);
    const bound =
      await sql`SELECT 1 FROM delivery_pod_media WHERE media_id=${mediaId}::uuid AND task_id=${taskId}::uuid AND rider_id=${riderId}::uuid`.execute(
        this.db,
      );
    if (!bound.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    await this.uploads.assertOwnedRegistered(riderId, mediaId, 'DELIVERY_POD');
  }
}
