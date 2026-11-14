import { randomBytes, randomUUID } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { CognitoTokenVerifier } from '../src/adapters/auth/cognito.js';
import { authorizeIdentity } from '../src/modules/identity/domain/identity-policy.js';
import { runAwsOrderSmoke } from './aws-order-smoke.js';

if (process.env.AWS_SMOKE_CREATE_USER !== 'yes')
  throw new Error('Explicit AWS_SMOKE_CREATE_USER=yes is required');
const region = process.env.AWS_REGION!;
const pool = process.env.COGNITO_CUSTOMER_POOL_ID!;
const adminClient = process.env.COGNITO_ADMIN_CLIENT_ID!;
const customerClient = process.env.COGNITO_CUSTOMER_CLIENT_ID!;
const email = `delivery-smoke-${randomUUID()}@example.invalid`;
const password = `A1!${randomBytes(24).toString('base64url')}`;
const client = new CognitoIdentityProviderClient({
  region,
  credentials: defaultProvider({ profile: 'default' }),
});
let createdSub: string | undefined;
let failure: unknown;

async function login(clientId: string): Promise<{ access: string; id: string }> {
  const start = await client.send(
    new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
    }),
  );
  let result = start.AuthenticationResult;
  if (!result && start.ChallengeName === 'PASSWORD' && start.Session) {
    const response = await client.send(
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: 'PASSWORD',
        Session: start.Session,
        ChallengeResponses: { USERNAME: email, PASSWORD: password },
      }),
    );
    result = response.AuthenticationResult;
  }
  const access = result?.AccessToken;
  const id = result?.IdToken;
  if (!access || !id) throw new Error('Cognito did not issue expected tokens');
  return { access, id };
}

try {
  const created = await client.send(
    new AdminCreateUserCommand({
      UserPoolId: pool,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'Delivery smoke test' },
      ],
    }),
  );
  createdSub = created.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
  if (!createdSub) throw new Error('Created user has no subject; manual review required');
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: pool,
      Username: createdSub,
      Password: password,
      Permanent: true,
    }),
  );
  await client.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: pool,
      Username: createdSub,
      GroupName: 'SUPER_ADMIN',
    }),
  );
  const admin = await login(adminClient);
  const customer = await login(customerClient);
  const rider = await login(process.env.COGNITO_RIDER_CLIENT_ID!);
  const store = await login(process.env.COGNITO_STORE_CLIENT_ID!);
  const verifier = new CognitoTokenVerifier({
    customerPoolId: pool,
    workforcePoolId: pool,
    customerClientId: customerClient,
    adminClientId: adminClient,
    riderClientId: process.env.COGNITO_RIDER_CLIENT_ID!,
    storeClientId: process.env.COGNITO_STORE_CLIENT_ID!,
    region,
  });
  const verified = await verifier.verify(admin.access, 'admin', 'access');
  const principal = {
    userId: randomUUID(),
    pool: 'WORKFORCE' as const,
    sub: createdSub,
    roles: ['SUPER_ADMIN' as const],
    status: 'ACTIVE' as const,
    emailVerified: true,
    authVersion: '1',
    riderStatus: null,
  };
  if (authorizeIdentity(verified, principal, 'admin', false).roles[0] !== 'SUPER_ADMIN')
    throw new Error('Admin role authorization failed');
  let denied = false;
  try {
    authorizeIdentity(verified, { ...principal, roles: [] }, 'admin', false);
  } catch {
    denied = true;
  }
  if (!denied) throw new Error('Admin client improperly granted a role');
  denied = false;
  try {
    await verifier.verify(customer.access, 'admin', 'access');
  } catch {
    denied = true;
  }
  if (!denied) throw new Error('Wrong app client accepted for admin');
  await verifier.verify(customer.id, 'customer', 'id');
  await verifier.verify(rider.access, 'rider', 'access');
  await verifier.verify(store.access, 'store', 'access');
  console.log(
    'All four Cognito clients: authentication and token binding OK; role grant and denial OK',
  );
  if (process.env.AWS_SMOKE_ORDER === 'yes') await runAwsOrderSmoke(customer, createdSub);
} catch (error) {
  failure = error;
} finally {
  if (createdSub) {
    try {
      const observed = await client.send(
        new AdminGetUserCommand({ UserPoolId: pool, Username: createdSub }),
      );
      const found = observed.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
      if (found !== createdSub)
        failure = new Error('Smoke user identity changed; manual cleanup required');
      else {
        await client.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: createdSub }));
        console.log('Temporary Cognito smoke user removed');
      }
    } catch (error) {
      failure = new Error('Cognito smoke user cleanup needs review', { cause: error });
    }
  } else {
    console.error(
      `No confirmed test user to remove; if the create call timed out, review Cognito for ${email}`,
    );
  }
}
if (failure) throw failure;
