/**
 * Controlled, resumable cutover for the current shared-pool development setup.
 * Default is read-only. Run with AWS_PROFILE=default and --apply only after the
 * new server, migrations and group worker have passed verification.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  DeleteGroupCommand,
  ListGroupsCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const apply = process.argv.includes('--apply');
const region = process.env.AWS_REGION,
  poolId = process.env.COGNITO_CUSTOMER_POOL_ID;
if (
  !region ||
  !poolId ||
  poolId !== process.env.COGNITO_WORKFORCE_POOL_ID ||
  !process.env.MIGRATION_DATABASE_URL ||
  !process.env.COGNITO_CUSTOMER_CLIENT_ID
)
  throw new Error('This cutover requires the configured shared pool and database owner.');
if (process.env.NODE_ENV !== 'development' || process.env.DATABASE_AUTH !== 'iam')
  throw new Error('This script supports the configured AWS development environment only.');
const url = new URL(process.env.MIGRATION_DATABASE_URL);
if (url.pathname !== '/deliveryapp' || url.password || url.search)
  throw new Error('Unexpected migration database configuration.');
const signer = new Signer({
  hostname: url.hostname,
  port: Number(url.port || 5432),
  username: decodeURIComponent(url.username),
  region,
});
const db = new pg.Client({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  database: 'deliveryapp',
  password: () => signer.getAuthToken(),
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
const cognito = new CognitoIdentityProviderClient({ region });
const appGroups = new Set([
  'CUSTOMER',
  'RIDER',
  'STORE_MANAGER',
  'SUPPORT_AGENT',
  'SUPER_ADMIN',
  'ADMIN',
  'PICKER',
]);
const subOf = (user) => user.Attributes?.find((a) => a.Name === 'sub')?.Value;
async function groupsFor(sub) {
  const names = [];
  let next;
  do {
    const page = await cognito.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: poolId,
        Username: sub,
        ...(next ? { NextToken: next } : {}),
      }),
    );
    names.push(
      ...(page.Groups ?? []).map((group) => group.GroupName).filter((name) => appGroups.has(name)),
    );
    next = page.NextToken;
  } while (next);
  return names;
}
async function usersIn(group) {
  const result = [];
  let next;
  do {
    const page = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: poolId,
        GroupName: group,
        ...(next ? { NextToken: next } : {}),
      }),
    );
    result.push(...(page.Users ?? []));
    next = page.NextToken;
  } while (next);
  return result;
}
async function allUsers() {
  const result = [];
  let next;
  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: poolId, ...(next ? { PaginationToken: next } : {}) }),
    );
    result.push(...(page.Users ?? []));
    next = page.PaginationToken;
  } while (next);
  return result;
}
function customerSignupSubjects() {
  const env = { ...process.env, AWS_PROFILE: 'default', AWS_DEFAULT_PROFILE: 'default' };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  const raw = execFileSync(
    'aws',
    [
      'cloudtrail',
      'lookup-events',
      '--region',
      region,
      '--lookup-attributes',
      'AttributeKey=EventName,AttributeValue=SignUp',
      '--output',
      'json',
    ],
    { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, env },
  );
  const events = JSON.parse(raw).Events ?? [];
  const subjects = new Set();
  for (const item of events) {
    const event = JSON.parse(item.CloudTrailEvent);
    if (
      event.requestParameters?.clientId === process.env.COGNITO_CUSTOMER_CLIENT_ID &&
      typeof event.responseElements?.userSub === 'string'
    )
      subjects.add(event.responseElements.userSub);
  }
  return subjects;
}

try {
  await db.connect();
  const migrations = await db.query(
    "SELECT name FROM pgmigrations WHERE name IN ('042_simplify_role_data','043_simplify_role_constraints','044_single_identity_role_indexes')",
  );
  if (apply && migrations.rows.length !== 3)
    throw new Error('Apply and verify migrations 042–044 before live cutover.');
  const groupPage = await cognito.send(new ListGroupsCommand({ UserPoolId: poolId }));
  const groupNames = new Set((groupPage.Groups ?? []).map((g) => g.GroupName));
  for (const name of ['CUSTOMER', 'RIDER', 'STORE_MANAGER', 'SUPPORT_AGENT', 'SUPER_ADMIN'])
    if (!groupNames.has(name)) throw new Error(`Required group ${name} is missing.`);
  const admins = groupNames.has('ADMIN') ? await usersIn('ADMIN') : [];
  const pickers = groupNames.has('PICKER') ? await usersIn('PICKER') : [];
  if (admins.length > 1 || pickers.length > 0)
    throw new Error('Legacy staff membership changed; review before continuing.');
  const pending =
    await db.query(`SELECT u.id,u.cognito_sub,u.status FROM users u JOIN audit_log a ON a.subject_id=u.id::text
    WHERE a.action='ROLE_SIMPLIFICATION_STARTED' AND NOT EXISTS (SELECT 1 FROM audit_log z WHERE z.action='ROLE_SIMPLIFICATION_COMPLETED' AND z.subject_id=u.id::text)
    ORDER BY a.created_at DESC LIMIT 2`);
  if (pending.rows.length > 1)
    throw new Error('Multiple incomplete owner transitions need review.');
  let ownerSub = pending.rows[0]?.cognito_sub;
  if (!ownerSub && admins.length === 1) {
    ownerSub = subOf(admins[0]);
    if (!ownerSub || !(await groupsFor(ownerSub)).includes('RIDER'))
      throw new Error('The expected admin/rider account changed; review before continuing.');
  }
  const owner = ownerSub
    ? (
        await db.query("SELECT id,status FROM users WHERE pool='WORKFORCE' AND cognito_sub=$1", [
          ownerSub,
        ])
      ).rows[0]
    : null;
  if (ownerSub && !owner) throw new Error('The existing owner workforce account was not found.');
  if (!ownerSub && groupNames.has('ADMIN'))
    throw new Error('The owner account cannot be determined safely.');
  const signupSubjects = customerSignupSubjects();
  const users = await allUsers();
  const customers = [];
  let unknown = 0;
  for (const user of users) {
    const sub = subOf(user);
    if (!sub || sub === ownerSub) continue;
    const attrs = Object.fromEntries(
      (user.Attributes ?? []).map(({ Name, Value }) => [Name, Value]),
    );
    const groups = await groupsFor(sub);
    if (groups.length > 1)
      throw new Error('An account has conflicting application groups; review before continuing.');
    if (
      groups.length ||
      !user.Enabled ||
      user.UserStatus !== 'CONFIRMED' ||
      attrs.email_verified !== 'true'
    )
      continue;
    const dbCustomer = await db.query(
      "SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.pool='CUSTOMER' AND u.cognito_sub=$1 AND u.status='ACTIVE' AND r.role='CUSTOMER'",
      [sub],
    );
    if (dbCustomer.rows.length || signupSubjects.has(sub)) customers.push(sub);
    else unknown++;
  }
  if (unknown)
    throw new Error(
      `${unknown} ungrouped account(s) have no verified customer origin; review them before cutover.`,
    );
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      legacyAdminMembers: admins.length,
      legacyPickerMembers: pickers.length,
      ownerTransitionRequired: !!owner,
      verifiedCustomersToGroup: customers.length,
      unclassifiedUsers: unknown,
    }),
  );
  if (!apply) process.exitCode = 0;
  else {
    if (owner) {
      await db.query('BEGIN');
      try {
        await db.query('SELECT pg_advisory_xact_lock(701002)');
        const locked = await db.query('SELECT id,status FROM users WHERE id=$1 FOR UPDATE', [
          owner.id,
        ]);
        if (!locked.rows.length || !['ACTIVE', 'BLOCKED'].includes(locked.rows[0].status))
          throw new Error('Owner status changed.');
        const obligations = await db.query(
          `SELECT
          EXISTS(SELECT 1 FROM delivery_tasks WHERE (rider_id=$1 OR offered_rider_id=$1) AND status IN ('OFFERED','ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')) AS tasks,
          EXISTS(SELECT 1 FROM rider_shifts WHERE rider_id=$1 AND ended_at IS NULL) AS shift,
          COALESCE((SELECT sum(delta_paise)<>0 FROM rider_cash_ledger WHERE rider_id=$1),false) AS cash`,
          [owner.id],
        );
        if (Object.values(obligations.rows[0]).some(Boolean))
          throw new Error('Resolve the owner account’s open rider obligations before conversion.');
        const queued = await db.query(
          "SELECT 1 FROM identity_sync_operations WHERE user_id=$1 AND state<>'COMPLETE' LIMIT 1",
          [owner.id],
        );
        if (queued.rows.length)
          throw new Error('Resolve pending identity synchronization for the owner first.');
        if (!pending.rows.length)
          await db.query(
            "INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES($1,NULL,'ROLE_SIMPLIFICATION_STARTED','user',$2,'{}'::jsonb)",
            [randomUUID(), owner.id],
          );
        await db.query(
          "UPDATE users SET status='BLOCKED',auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=$1",
          [owner.id],
        );
        await db.query('DELETE FROM store_staff WHERE user_id=$1', [owner.id]);
        await db.query('DELETE FROM user_roles WHERE user_id=$1', [owner.id]);
        await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'SUPER_ADMIN')", [owner.id]);
        await db.query('INSERT INTO staff_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING', [
          owner.id,
        ]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      let memberships = await groupsFor(ownerSub);
      if (memberships.some((name) => !['ADMIN', 'RIDER', 'SUPER_ADMIN'].includes(name)))
        throw new Error('Unexpected owner group; account remains blocked for review.');
      for (const name of ['ADMIN', 'RIDER'])
        if (memberships.includes(name))
          await cognito.send(
            new AdminRemoveUserFromGroupCommand({
              UserPoolId: poolId,
              Username: ownerSub,
              GroupName: name,
            }),
          );
      memberships = await groupsFor(ownerSub);
      if (!memberships.includes('SUPER_ADMIN'))
        await cognito.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: poolId,
            Username: ownerSub,
            GroupName: 'SUPER_ADMIN',
          }),
        );
      await cognito.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: ownerSub }),
      );
      memberships = await groupsFor(ownerSub);
      if (memberships.length !== 1 || memberships[0] !== 'SUPER_ADMIN')
        throw new Error('Owner group verification failed; account remains blocked.');
      await db.query('BEGIN');
      try {
        await db.query(
          "UPDATE users SET status='ACTIVE',auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=$1 AND status='BLOCKED'",
          [owner.id],
        );
        await db.query(
          "INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES($1,NULL,'ROLE_SIMPLIFICATION_COMPLETED','user',$2,$3::jsonb)",
          [randomUUID(), owner.id, JSON.stringify({ from: ['ADMIN', 'RIDER'], to: 'SUPER_ADMIN' })],
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
    for (const sub of customers) {
      const current = await groupsFor(sub);
      if (current.length)
        throw new Error('Customer membership changed during cutover; rerun after review.');
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: poolId,
          Username: sub,
          GroupName: 'CUSTOMER',
        }),
      );
      const after = await groupsFor(sub);
      if (after.length !== 1 || after[0] !== 'CUSTOMER')
        throw new Error('Customer group verification failed.');
    }
    for (const name of ['ADMIN', 'PICKER'])
      if (groupNames.has(name)) {
        if ((await usersIn(name)).length)
          throw new Error(`The ${name} group is not empty; it was not deleted.`);
        await cognito.send(new DeleteGroupCommand({ UserPoolId: poolId, GroupName: name }));
      }
    console.log('Role cutover complete. The converted admin must sign in again.');
  }
} finally {
  await db.end().catch(() => {});
  cognito.destroy();
}
