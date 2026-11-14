import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createTrigger } from './trigger.mjs';
import { createHandler as createWorker } from './worker.mjs';

const poolId = 'ap-southeast-2_example';
const clientId = 'customerclient';
const subject = '00000000-1111-2222-3333-444444444444';
const signup = () => ({
  triggerSource: 'PostConfirmation_ConfirmSignUp',
  userPoolId: poolId,
  callerContext: { clientId },
  request: { userAttributes: { sub: subject, email_verified: 'true' } },
  response: {},
});
const record = (id = 'one') => ({
  messageId: id,
  body: JSON.stringify({ version: 1, userPoolId: poolId, subject }),
});
const verifiedUser = () => ({
  Enabled: true,
  UserStatus: 'CONFIRMED',
  UserAttributes: [
    { Name: 'sub', Value: subject },
    { Name: 'email_verified', Value: 'true' },
  ],
});

test('only confirmed, verified signups from the customer client are enqueued', async () => {
  const sent = [];
  const handle = createTrigger({
    client: { send: async (command) => sent.push(command.input) },
    queueUrl: 'queue',
    poolId,
    customerClientId: clientId,
    reportFailure: () => assert.fail(),
  });
  const event = signup();
  assert.equal(await handle(event), event);
  assert.deepEqual(JSON.parse(sent[0].MessageBody), { version: 1, userPoolId: poolId, subject });
  for (const change of [
    (e) => {
      e.triggerSource = 'PostConfirmation_ConfirmForgotPassword';
    },
    (e) => {
      e.callerContext.clientId = 'workforceclient';
    },
    (e) => {
      e.userPoolId = 'other';
    },
    (e) => {
      e.request.userAttributes.email_verified = 'false';
    },
  ]) {
    const other = signup();
    change(other);
    await handle(other);
  }
  assert.equal(sent.length, 1);
});

test('a queue outage is reported without falsely failing an already-confirmed signup', async () => {
  let failures = 0;
  let failedSubject;
  let failedRole;
  const handle = createTrigger({
    client: {
      send: async () => {
        throw Error('private');
      },
    },
    queueUrl: 'queue',
    poolId,
    customerClientId: clientId,
    reportFailure: (value, role) => {
      failures++;
      failedSubject = value;
      failedRole = role;
    },
  });
  const event = signup();
  assert.equal(await handle(event), event);
  assert.equal(failures, 1);
  assert.equal(failedSubject, subject);
  assert.equal(failedRole, 'CUSTOMER');
});

test('verified rider signup is enqueued separately and cannot grant a privileged role', async () => {
  const sent = [];
  const handle = createTrigger({
    client: { send: async (command) => sent.push(JSON.parse(command.input.MessageBody)) },
    queueUrl: 'queue',
    poolId,
    customerClientId: clientId,
    riderClientId: 'riderclient',
    reportFailure: () => assert.fail(),
  });
  const event = signup();
  event.callerContext.clientId = 'riderclient';
  await handle(event);
  assert.deepEqual(sent, [{ version: 2, userPoolId: poolId, subject, role: 'RIDER' }]);
  event.callerContext.clientId = 'adminclient';
  await handle(event);
  assert.equal(sent.length, 1);
});

test('rider worker rejects conflicting groups and invalid privileged messages', async () => {
  const commands = [],
    reasons = [];
  const handle = createWorker({
    poolId,
    reportFailure: (reason) => reasons.push(reason),
    client: {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'AdminGetUserCommand') return verifiedUser();
        if (command.constructor.name === 'AdminListGroupsForUserCommand')
          return { Groups: [{ GroupName: 'CUSTOMER' }] };
        return {};
      },
    },
  });
  const body = JSON.stringify({ version: 2, userPoolId: poolId, subject, role: 'RIDER' });
  const bad = JSON.stringify({ version: 2, userPoolId: poolId, subject, role: 'SUPER_ADMIN' });
  assert.deepEqual(
    await handle({
      Records: [
        { messageId: 'conflict', body },
        { messageId: 'bad', body: bad },
      ],
    }),
    { batchItemFailures: [{ itemIdentifier: 'conflict' }, { itemIdentifier: 'bad' }] },
  );
  assert.deepEqual(reasons.sort(), ['INVALID_MESSAGE', 'ROLE_CONFLICT']);
  assert.equal(
    commands.some((c) => c.constructor.name === 'AdminAddUserToGroupCommand'),
    false,
  );
});

test('verified rider is assigned only to RIDER', async () => {
  const commands = [];
  const handle = createWorker({
    poolId,
    reportFailure: () => assert.fail(),
    client: {
      send: async (command) => {
        commands.push(command);
        return command.constructor.name === 'AdminGetUserCommand' ? verifiedUser() : {};
      },
    },
  });
  const body = JSON.stringify({ version: 2, userPoolId: poolId, subject, role: 'RIDER' });
  assert.deepEqual(await handle({ Records: [{ messageId: 'rider', body }] }), {
    batchItemFailures: [],
  });
  assert.equal(commands[2].input.GroupName, 'RIDER');
});

test('worker checks the current user and adds verified users to CUSTOMER', async () => {
  const commands = [];
  const handle = createWorker({
    poolId,
    reportFailure: () => assert.fail(),
    client: {
      send: async (command) => {
        commands.push(command);
        return command.constructor.name === 'AdminGetUserCommand' ? verifiedUser() : {};
      },
    },
  });
  assert.deepEqual(await handle({ Records: [record()] }), { batchItemFailures: [] });
  assert.deepEqual(commands[2].input, {
    UserPoolId: poolId,
    Username: subject,
    GroupName: 'CUSTOMER',
  });
});

test('worker refuses to add a workforce member to the customer group', async () => {
  const commands = [];
  let failures = 0;
  const handle = createWorker({
    poolId,
    reportFailure: () => {
      failures++;
    },
    client: {
      send: async (command) => {
        commands.push(command.constructor.name);
        if (command.constructor.name === 'AdminGetUserCommand') return verifiedUser();
        if (command.constructor.name === 'AdminListGroupsForUserCommand')
          return { Groups: [{ GroupName: 'RIDER' }] };
        return {};
      },
    },
  });
  assert.deepEqual(await handle({ Records: [record()] }), {
    batchItemFailures: [{ itemIdentifier: 'one' }],
  });
  assert.equal(failures, 1);
  assert.equal(commands.includes('AdminAddUserToGroupCommand'), false);
});

test('worker skips disabled or unverified accounts and retries only failed records', async () => {
  let adds = 0;
  const handle = createWorker({
    poolId,
    reportFailure: () => {},
    client: {
      send: async (command) => {
        if (command.constructor.name === 'AdminAddUserToGroupCommand') {
          adds++;
          throw Error('retry');
        }
        return verifiedUser();
      },
    },
  });
  const malformed = { messageId: 'bad', body: '{' };
  assert.deepEqual(await handle({ Records: [record('retry'), malformed] }), {
    batchItemFailures: [{ itemIdentifier: 'retry' }, { itemIdentifier: 'bad' }],
  });
  assert.equal(adds, 1);
  const disabled = createWorker({
    poolId,
    reportFailure: () => assert.fail(),
    client: { send: async () => ({ ...verifiedUser(), Enabled: false }) },
  });
  assert.deepEqual(await disabled({ Records: [record()] }), { batchItemFailures: [] });
  const unverified = createWorker({
    poolId,
    reportFailure: () => assert.fail(),
    client: {
      send: async () => ({
        ...verifiedUser(),
        UserAttributes: [
          { Name: 'sub', Value: subject },
          { Name: 'email_verified', Value: 'false' },
        ],
      }),
    },
  });
  assert.deepEqual(await unverified({ Records: [record()] }), { batchItemFailures: [] });
});

test('a deleted user is discarded but a subject mismatch is retried', async () => {
  const deleted = createWorker({
    poolId,
    reportFailure: () => assert.fail(),
    client: {
      send: async () => {
        const error = Error();
        error.name = 'UserNotFoundException';
        throw error;
      },
    },
  });
  assert.deepEqual(await deleted({ Records: [record()] }), { batchItemFailures: [] });
  const mismatch = createWorker({
    poolId,
    reportFailure: () => {},
    client: {
      send: async () => ({
        ...verifiedUser(),
        UserAttributes: [
          { Name: 'sub', Value: 'different' },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    },
  });
  assert.deepEqual(await mismatch({ Records: [record()] }), {
    batchItemFailures: [{ itemIdentifier: 'one' }],
  });
});
