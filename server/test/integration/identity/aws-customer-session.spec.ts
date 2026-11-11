import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { PLATFORM_DATABASE } from '../../../src/platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

const awsOnly = process.env.AWS_P13_INTEGRATION === 'yes' ? describe : describe.skip;
awsOnly('Cognito customer with isolated AWS database', () => {
  let services: TestServices | undefined;
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  const createdUsers: string[] = [];
  const username = `smoke-${randomUUID()}@example.invalid`;
  const password = `Ab9!${randomBytes(16).toString('hex')}`;
  const pool = process.env.COGNITO_CUSTOMER_POOL_ID!;
  const clientId = process.env.COGNITO_CUSTOMER_CLIENT_ID!;
  const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
  beforeAll(async () => {
    services = await startTestServices({ skipAwsCache: true });
    await runner({
      databaseUrl: services.databaseUrl,
      dir: resolve('db/migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseIamUrl!,
      DATABASE_AUTH: 'iam',
      AWS_REGION: process.env.AWS_REGION,
      DB_ACQUIRE_TIMEOUT_MS: '30000',
      REDIS_URL: 'redis://127.0.0.1:1',
      AUTH_PROVIDER: 'cognito',
      COGNITO_CUSTOMER_POOL_ID: pool,
      COGNITO_CUSTOMER_CLIENT_ID: clientId,
      COGNITO_WORKFORCE_POOL_ID: process.env.COGNITO_WORKFORCE_POOL_ID,
      COGNITO_RIDER_CLIENT_ID: process.env.COGNITO_RIDER_CLIENT_ID,
      COGNITO_STORE_CLIENT_ID: process.env.COGNITO_STORE_CLIENT_ID,
      COGNITO_ADMIN_CLIENT_ID: process.env.COGNITO_ADMIN_CLIENT_ID,
    });
    app = await createApplication(env, []);
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: pool,
        Username: username,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: 'Temporary Test' },
        ],
      }),
    );
    createdUsers.push(username);
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: pool,
        Username: username,
        Password: password,
        Permanent: true,
      }),
    );
  }, 300000);
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        for (const user of createdUsers)
          await cognito.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: user }));
      } finally {
        cognito.destroy();
        await services?.stop();
      }
    }
  }, 300000);
  it('signs in, bootstraps, reads account data and keeps profile edits across sign-in', async () => {
    let login = await cognito.send(
      new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: 'USER_AUTH',
        AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
      }),
    );
    if (login.ChallengeName === 'PASSWORD' && login.Session)
      login = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: clientId,
          ChallengeName: 'PASSWORD',
          Session: login.Session,
          ChallengeResponses: { USERNAME: username, PASSWORD: password },
        }),
      );
    const id = login.AuthenticationResult?.IdToken,
      access = login.AuthenticationResult?.AccessToken;
    expect(id).toBeTruthy();
    expect(access).toBeTruthy();
    if (!id || !access || !app) throw new Error('Test sign-in failed');
    const server = app.getHttpAdapter().getInstance();
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/customer/auth/bootstrap',
          headers: { authorization: `Bearer ${id}` },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/customer/me',
          headers: { authorization: `Bearer ${access}` },
        })
      ).json(),
    ).toMatchObject({ email: username, name: 'Temporary Test' });
    expect(
      (
        await server.inject({
          method: 'PATCH',
          url: '/v1/customer/me',
          headers: { authorization: `Bearer ${access}` },
          payload: { name: 'Edited Name' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/customer/auth/bootstrap',
          headers: { authorization: `Bearer ${id}` },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/customer/me',
          headers: { authorization: `Bearer ${access}` },
        })
      ).json(),
    ).toMatchObject({ name: 'Edited Name' });
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/customer/addresses',
          headers: { authorization: `Bearer ${access}` },
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/customer/orders',
          headers: { authorization: `Bearer ${access}` },
        })
      ).json(),
    ).toMatchObject({ items: [] });
    expect((await server.inject({ method: 'GET', url: '/v1/customer/me' })).statusCode).toBe(401);

    // Only the isolated database gets this flag; no shared AWS application configuration is changed.
    const db = app.get<DatabaseHandle>(PLATFORM_DATABASE).db;
    await sql`INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
      db,
    );
    const referralResponse = await server.inject({
      method: 'GET',
      url: '/v1/customer/referrals',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(referralResponse.statusCode).toBe(200);
    const referralCode = referralResponse.json().code as string;
    expect(referralCode).toMatch(/^[A-F0-9]{16}$/);
    const friend = `smoke-${randomUUID()}@example.invalid`;
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: pool,
        Username: friend,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: friend },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: 'Temporary Friend' },
        ],
      }),
    );
    createdUsers.push(friend);
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: pool,
        Username: friend,
        Password: password,
        Permanent: true,
      }),
    );
    let friendLogin = await cognito.send(
      new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: 'USER_AUTH',
        AuthParameters: { USERNAME: friend, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
      }),
    );
    if (friendLogin.ChallengeName === 'PASSWORD' && friendLogin.Session)
      friendLogin = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: clientId,
          ChallengeName: 'PASSWORD',
          Session: friendLogin.Session,
          ChallengeResponses: { USERNAME: friend, PASSWORD: password },
        }),
      );
    const friendId = friendLogin.AuthenticationResult?.IdToken;
    const friendAccess = friendLogin.AuthenticationResult?.AccessToken;
    if (!friendId || !friendAccess) throw new Error('Temporary friend authentication failed');
    const bootstrap = () =>
      server.inject({
        method: 'POST',
        url: '/v1/customer/auth/bootstrap',
        headers: { authorization: `Bearer ${friendId}` },
        payload: { referralCode },
      });
    expect((await bootstrap()).statusCode).toBe(201);
    expect((await bootstrap()).statusCode).toBe(201);
    const balance = await server.inject({
      method: 'GET',
      url: '/v1/customer/wallet',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ promoPaise: '1000' });
    const friendReferral = await server.inject({
      method: 'GET',
      url: '/v1/customer/referrals',
      headers: { authorization: `Bearer ${friendAccess}` },
    });
    expect(friendReferral.statusCode).toBe(200);
    expect(friendReferral.json()).toMatchObject({ freeDeliveryAvailable: true });
  }, 300000);
});
