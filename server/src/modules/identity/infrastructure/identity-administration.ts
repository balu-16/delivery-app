import type { ApprovalExecutor, ApprovalFactory } from '../../compliance/contracts/approval.js';
import type { Json } from '../../../platform/database/database.js';
import { IdentityAdminService } from './admin-service.js';
import type { IdentityAdministration, Role } from '../contracts/identity.js';
const manageable: readonly string[] = ['RIDER', 'STORE_MANAGER', 'SUPPORT_AGENT', 'SUPER_ADMIN'];
export class IdentityAdministrationService implements IdentityAdministration {
  private readonly approvals: ApprovalExecutor;
  constructor(
    private readonly admin: IdentityAdminService,
    factory: ApprovalFactory,
  ) {
    this.approvals = factory.create({
      'identity.role.change': {
        version: 1,
        makerRole: 'SUPER_ADMIN',
        checkerRole: 'SUPER_ADMIN',
        ttlSeconds: 86400,
        validate: (payload) =>
          !!payload &&
          !Array.isArray(payload) &&
          typeof payload === 'object' &&
          Object.keys(payload).sort().join(',') === 'grant,role,userId' &&
          typeof payload.userId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.userId) &&
          typeof payload.role === 'string' &&
          manageable.includes(payload.role) &&
          typeof payload.grant === 'boolean',
        execute: async (tx, payload: Json, _key, checkerId) => {
          if (
            !payload ||
            Array.isArray(payload) ||
            typeof payload !== 'object' ||
            typeof payload.userId !== 'string' ||
            typeof payload.role !== 'string' ||
            !manageable.includes(payload.role) ||
            typeof payload.grant !== 'boolean'
          )
            throw new Error('INVALID_ROLE_CHANGE');
          await admin.setRoleInTransaction(
            tx,
            checkerId,
            payload.userId,
            payload.role as Role,
            payload.grant,
          );
        },
      },
    });
  }
  async listUsers(actorId: string, search: string, before?: string) {
    return this.admin.listUsers(actorId, search, before);
  }
  async setBlocked(actorId: string, userId: string, blocked: boolean): Promise<void> {
    await this.admin.setBlocked(actorId, userId, blocked);
  }
  async resetPassword(actorId: string, userId: string): Promise<void> {
    await this.admin.resetPassword(actorId, userId);
  }
  async setStoreAssignment(
    actorId: string,
    userId: string,
    storeId: string,
    role: 'STORE_MANAGER',
    grant: boolean,
  ): Promise<void> {
    await this.admin.setStoreAssignment(actorId, userId, storeId, role, grant);
  }
  async requestRoleChange(
    makerId: string,
    userId: string,
    role: Role,
    grant: boolean,
  ): Promise<string> {
    if (!manageable.includes(role)) throw new Error('ROLE_NOT_MANAGED');
    return this.approvals.request(makerId, 'identity.role.change', { userId, role, grant });
  }
  async approveRoleChange(checkerId: string, requestId: string): Promise<void> {
    await this.approvals.approve(checkerId, requestId);
  }
}
