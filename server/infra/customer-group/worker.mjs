import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

function parseMessage(body, poolId) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('INVALID_MESSAGE');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !(
      (value.version === 1 &&
        Object.keys(value).sort().join(',') === 'subject,userPoolId,version') ||
      (value.version === 2 &&
        Object.keys(value).sort().join(',') === 'role,subject,userPoolId,version' &&
        value.role === 'RIDER')
    ) ||
    value.userPoolId !== poolId ||
    typeof value.subject !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.subject)
  )
    throw new Error('INVALID_MESSAGE');
  return { subject: value.subject, role: value.version === 1 ? 'CUSTOMER' : 'RIDER' };
}

export function createHandler({ client, poolId, reportFailure }) {
  return async (event) => {
    const results = await Promise.all(
      (event.Records ?? []).map(async (record) => {
        try {
          const { subject, role } = parseMessage(record.body, poolId);
          let user;
          try {
            user = await client.send(
              new AdminGetUserCommand({ UserPoolId: poolId, Username: subject }),
              { abortSignal: globalThis.AbortSignal.timeout(4000) },
            );
          } catch (error) {
            // A deleted account cannot be assigned; no retry is needed.
            if (error?.name === 'UserNotFoundException') return null;
            throw error;
          }
          const attrs = Object.fromEntries(
            (user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]),
          );
          if (attrs.sub !== subject) throw new Error('SUBJECT_MISMATCH');
          if (
            !user.Enabled ||
            attrs.email_verified !== 'true' ||
            !['CONFIRMED', 'RESET_REQUIRED'].includes(user.UserStatus)
          )
            return null;
          // A signup must never add a second application role. Conflicts are
          // retried and sent to the DLQ for an operator to review.
          let nextToken;
          do {
            const page = await client.send(
              new AdminListGroupsForUserCommand({
                UserPoolId: poolId,
                Username: subject,
                ...(nextToken ? { NextToken: nextToken } : {}),
              }),
              { abortSignal: globalThis.AbortSignal.timeout(4000) },
            );
            if (
              (page.Groups ?? []).some(
                (group) =>
                  group.GroupName !== role &&
                  [
                    'CUSTOMER',
                    'RIDER',
                    'STORE_MANAGER',
                    'SUPPORT_AGENT',
                    'SUPER_ADMIN',
                    'ADMIN',
                    'PICKER',
                  ].includes(group.GroupName),
              )
            )
              throw new Error('ROLE_CONFLICT');
            nextToken = page.NextToken;
          } while (nextToken);
          await client.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: poolId,
              Username: subject,
              GroupName: role,
            }),
            { abortSignal: globalThis.AbortSignal.timeout(4000) },
          );
          return null;
        } catch (error) {
          // Log only a small set of non-sensitive diagnostic codes.
          const allowed = new Set([
            'INVALID_MESSAGE',
            'SUBJECT_MISMATCH',
            'ROLE_CONFLICT',
            'AccessDeniedException',
            'TooManyRequestsException',
            'ThrottlingException',
          ]);
          const reason = allowed.has(error?.message)
            ? error.message
            : allowed.has(error?.name)
              ? error.name
              : 'OTHER';
          reportFailure(reason);
          return { itemIdentifier: record.messageId };
        }
      }),
    );
    return { batchItemFailures: results.filter(Boolean) };
  };
}

let handlerInstance;
export const handler = async (event) => {
  handlerInstance ??= createHandler({
    client: new CognitoIdentityProviderClient({ maxAttempts: 2 }),
    poolId: process.env.CUSTOMER_POOL_ID,
    reportFailure: (reason) =>
      console.error(JSON.stringify({ event: 'CUSTOMER_GROUP_WORKER_FAILED', reason })),
  });
  return handlerInstance(event);
};
