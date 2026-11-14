import type { Audience, Principal, Role, VerifiedIdentity } from '../contracts/identity.js';

const audienceRoles: Record<Audience, readonly Role[]> = {
  customer: ['CUSTOMER'],
  rider: ['RIDER'],
  store: ['STORE_MANAGER'],
  admin: ['SUPPORT_AGENT', 'SUPER_ADMIN'],
};

// Retired groups also count as conflicts until stale tokens expire.
const applicationGroups = new Set([
  'CUSTOMER',
  'RIDER',
  'STORE_MANAGER',
  'SUPPORT_AGENT',
  'SUPER_ADMIN',
  'PICKER',
  'ADMIN',
]);

export function hasOnlyApplicationGroup(groups: readonly string[], role: Role): boolean {
  const relevant = groups.filter((group) => applicationGroups.has(group));
  return relevant.length === 1 && relevant[0] === role;
}

/** An ungrouped verified account can bootstrap while group assignment is pending. */
export function canBootstrapRole(groups: readonly string[], role: Role): boolean {
  const relevant = groups.filter((group) => applicationGroups.has(group));
  return relevant.length === 0 || (relevant.length === 1 && relevant[0] === role);
}

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
  if (
    principal.roles.length !== 1 ||
    !hasOnlyApplicationGroup(identity.groups, principal.roles[0]!)
  )
    throw new Error('FORBIDDEN');
  const matching = principal.roles.filter((role) => audienceRoles[audience].includes(role));
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
