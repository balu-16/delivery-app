import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { CognitoTokenVerifier } from '../../../src/adapters/auth/cognito.js';

test('Cognito tokens enforce signature, pool, client, use and expiry and refresh rotated keys', async () => {
  const one = await generateKeyPair('RS256');
  const two = await generateKeyPair('RS256');
  const key1 = { ...(await exportJWK(one.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const key2 = { ...(await exportJWK(two.publicKey)), kid: 'key-2', alg: 'RS256', use: 'sig' };
  let keys = [key1];
  let fetches = 0;
  const cache = new SimpleJwksCache({
    fetcher: {
      fetch: async () => {
        fetches++;
        return new TextEncoder().encode(JSON.stringify({ keys })).buffer;
      },
    },
  });
  const verifier = new CognitoTokenVerifier(
    {
      customerPoolId: 'us-east-1_customer',
      customerClientId: 'customer-client',
      workforcePoolId: 'us-east-1_workforce',
      riderClientId: 'rider-client',
      storeClientId: 'store-client',
      adminClientId: 'admin-client',
      region: 'us-east-1',
    },
    cache,
  );
  const issuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_workforce';
  const token = async (
    opts: {
      key?: typeof one.privateKey;
      kid?: string;
      issuer?: string;
      client?: string;
      use?: string;
      expires?: number;
      groups?: string[];
    } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      token_use: opts.use ?? 'access',
      client_id: opts.client ?? 'rider-client',
      ...(opts.groups ? { 'cognito:groups': opts.groups } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'key-1' })
      .setIssuer(opts.issuer ?? issuer)
      .setSubject('subject')
      .setIssuedAt(now)
      .setExpirationTime(opts.expires ?? now + 300)
      .sign(opts.key ?? one.privateKey);
  };
  expect(
    await verifier.verify(await token({ groups: ['RIDER'] }), 'rider', 'access'),
  ).toMatchObject({ pool: 'WORKFORCE', sub: 'subject', groups: ['RIDER'] });
  expect((await verifier.verify(await token(), 'rider', 'access')).groups).toEqual([]);
  await expect(
    verifier.verify(await token({ client: 'store-client' }), 'rider', 'access'),
  ).rejects.toThrow();
  await expect(
    verifier.verify(await token({ issuer: 'https://example.invalid' }), 'rider', 'access'),
  ).rejects.toThrow();
  await expect(verifier.verify(await token({ use: 'id' }), 'rider', 'access')).rejects.toThrow();
  // The configured 60-second grace accepts a slightly expired token.
  expect(
    await verifier.verify(
      await token({ expires: Math.floor(Date.now() / 1000) - 30 }),
      'rider',
      'access',
    ),
  ).toMatchObject({ sub: 'subject' });
  await expect(
    verifier.verify(
      await token({ expires: Math.floor(Date.now() / 1000) - 61 }),
      'rider',
      'access',
    ),
  ).rejects.toThrow();
  await expect(
    verifier.verify(await token({ key: two.privateKey }), 'rider', 'access'),
  ).rejects.toThrow();
  keys = [key1, key2];
  expect(
    await verifier.verify(await token({ key: two.privateKey, kid: 'key-2' }), 'rider', 'access'),
  ).toMatchObject({ sub: 'subject' });
  expect(fetches).toBe(2);
});

test('a shared Cognito pool still binds each access token to its application client', async () => {
  const pair = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'shared', alg: 'RS256', use: 'sig' };
  const cache = new SimpleJwksCache({
    fetcher: {
      fetch: async () => new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer,
    },
  });
  const verifier = new CognitoTokenVerifier(
    {
      customerPoolId: 'us-east-1_shared',
      workforcePoolId: 'us-east-1_shared',
      customerClientId: 'customer',
      riderClientId: 'rider',
      storeClientId: 'store',
      adminClientId: 'admin',
      region: 'us-east-1',
    },
    cache,
  );
  const sign = (client: string) =>
    new SignJWT({ token_use: 'access', client_id: client })
      .setProtectedHeader({ alg: 'RS256', kid: 'shared' })
      .setIssuer('https://cognito-idp.us-east-1.amazonaws.com/us-east-1_shared')
      .setSubject('same-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  const customer = await sign('customer');
  const admin = await sign('admin');
  expect((await verifier.verify(customer, 'customer', 'access')).pool).toBe('CUSTOMER');
  expect((await verifier.verify(admin, 'admin', 'access')).pool).toBe('WORKFORCE');
  await expect(verifier.verify(customer, 'admin', 'access')).rejects.toThrow();
  await expect(verifier.verify(admin, 'customer', 'access')).rejects.toThrow();
});
