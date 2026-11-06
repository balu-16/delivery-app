import type { Audience, Principal, Role, VerifiedIdentity } from '../contracts/identity.js';

const audienceRoles: Record<Audience, readonly Role[]> = {
  customer: ['CUSTOMER'],
  rider: ['RIDER'],
  store: ['PICKER', 'STORE_MANAGER'],
  admin: ['SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'],
};

/** Token groups only narrow permissions; the local account is the authority for current access. */
export function authorizeIdentity(
  identity: VerifiedIdentity,
  principal: Principal | null,
  audience: Audience,
  allowPendingRider: boolean,
): Principal {
  if (!principal) throw new Error('PROFILE_NOT_INITIALIZED');
  if (principal.status !== 'ACTIVE') throw new Error('ACCOUNT_DISABLED');
  if (
    (audience === 'customer') !== (identity.pool === 'CUSTOMER') ||
    principal.pool !== identity.pool ||
    principal.sub !== identity.sub
  )
    throw new Error('FORBIDDEN');
  const matching = principal.roles.filter(
    (role) =>
      audienceRoles[audience].includes(role) &&
      (audience === 'customer' || identity.groups.includes(role)),
  );
  if (!matching.length) throw new Error('FORBIDDEN');
  if (audience === 'rider' && !allowPendingRider && principal.riderStatus !== 'APPROVED')
    throw new Error('RIDER_NOT_APPROVED');
  return { ...principal, roles: matching };
}

export function documentsReady(
  required: readonly string[],
  documents: readonly { document_type: string; status: string }[],
): boolean {
  return (
    required.length > 0 &&
    required.every((type) =>
      documents.some(
        (document) => document.document_type === type && document.status !== 'REJECTED',
      ),
    )
  );
}
export function documentsApproved(
  required: readonly string[],
  documents: readonly { document_type: string; status: string }[],
): boolean {
  return (
    required.length > 0 &&
    required.every((type) =>
      documents.some(
        (document) => document.document_type === type && document.status === 'APPROVED',
      ),
    )
  );
}
