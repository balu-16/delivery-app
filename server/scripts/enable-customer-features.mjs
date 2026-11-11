import { createApplication } from '../dist/bootstrap.js';
import { readEnv } from '../dist/config/env.schema.js';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';

// Run against the configured development environment. Credentials stay in
// memory and are never accepted as arguments or included in command history.
const env = readEnv({ ...process.env, APP_ROLE: 'admin', LOG_LEVEL: 'error' });
if (env.NODE_ENV !== 'development' || env.AUTH_PROVIDER !== 'cognito') {
  throw new Error('This helper requires a Cognito-backed development environment');
}
async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('An interactive terminal is required for sign-in');
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('Sign-in cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1);
            if (!hidden) process.stderr.write('\b \b');
          }
        } else if (char >= ' ' && value.length < 1024) {
          value += char;
          if (!hidden) process.stderr.write(char);
        }
      }
    };
    process.stdin.on('data', onData);
  });
}
async function signIn() {
  const username = (await prompt('Workforce admin email: ')).trim();
  const password = await prompt('Password (hidden): ', true);
  if (!username || !password) throw new Error('Email and password are required');
  const client = new CognitoIdentityProviderClient({ region: env.AWS_REGION });
  try {
    let response = await client.send(
      new InitiateAuthCommand({
        ClientId: env.COGNITO_ADMIN_CLIENT_ID,
        AuthFlow: 'USER_AUTH',
        AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
      }),
      { abortSignal: globalThis.AbortSignal.timeout(20000) },
    );
    const codeKeys = {
      SOFTWARE_TOKEN_MFA: 'SOFTWARE_TOKEN_MFA_CODE',
      SMS_MFA: 'SMS_MFA_CODE',
      EMAIL_MFA: 'EMAIL_MFA_CODE',
      EMAIL_OTP: 'EMAIL_OTP_CODE',
      SMS_OTP: 'SMS_OTP_CODE',
    };
    for (let attempt = 0; !response.AuthenticationResult?.AccessToken && attempt < 5; attempt++) {
      const challenge = response.ChallengeName;
      if (!challenge || !response.Session) throw new Error('Cognito did not issue an access token');
      const values = { USERNAME: username };
      if (challenge === 'PASSWORD') values.PASSWORD = password;
      else if (codeKeys[challenge])
        values[codeKeys[challenge]] = await prompt('Verification code (hidden): ', true);
      else throw new Error(`Finish ${challenge} setup in the workforce sign-in flow, then retry`);
      response = await client.send(
        new RespondToAuthChallengeCommand({
          ClientId: env.COGNITO_ADMIN_CLIENT_ID,
          ChallengeName: challenge,
          Session: response.Session,
          ChallengeResponses: values,
        }),
        { abortSignal: globalThis.AbortSignal.timeout(20000) },
      );
    }
    if (!response.AuthenticationResult?.AccessToken)
      throw new Error('Cognito did not issue an access token');
    return response.AuthenticationResult.AccessToken;
  } finally {
    client.destroy();
  }
}
let token = '';
if (process.stdin.isTTY) {
  try {
    token = await signIn();
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith('Finish ')
        ? error.message
        : 'Admin sign-in failed. Check the account, verification code and connection.';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
} else {
  for await (const chunk of process.stdin) {
    token += chunk.toString('utf8');
    if (token.length > 16384) throw new Error('Invalid access token');
  }
  token = token.trim();
}
if (!token) throw new Error('An access token is required');
const app = await createApplication(env);
const server = app.getHttpAdapter().getInstance();
async function request(method, url, payload) {
  const result = await server.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    let code = 'REQUEST_FAILED';
    try {
      code = result.json().code ?? code;
    } catch {
      /* Do not print an untrusted response. */
    }
    throw new Error(`${method} ${url.split('?')[0]} failed (${result.statusCode}, ${code})`);
  }
  return result.body ? result.json() : undefined;
}
try {
  // This route verifies both the Cognito audience and SUPER_ADMIN role before any writes.
  const config = await request('GET', '/v1/admin/config');
  const stores = [];
  let cursor = null;
  do {
    const page = await request(
      'GET',
      `/v1/admin/stores?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!Array.isArray(page.items)) throw new Error('Unexpected store response');
    stores.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  if (!config.flags.wallet_enabled) {
    await request('POST', '/v1/admin/feature-flags/wallet_enabled', { enabled: true });
    process.stdout.write('Wallet enabled.\n');
  } else process.stdout.write('Wallet already enabled.\n');
  let updated = 0;
  for (const store of stores) {
    if (!store.accepts_cod) {
      await request('PATCH', `/v1/admin/stores/${encodeURIComponent(store.id)}/cod`, {
        enabled: true,
        version: store.version,
      });
      updated++;
    }
  }
  process.stdout.write(
    `Cash on delivery enabled for ${updated} store(s); ${stores.length} checked.\n`,
  );
  if (!config.flags.cod_enabled) {
    await request('POST', '/v1/admin/feature-flags/cod_enabled', { enabled: true });
    process.stdout.write('Cash on delivery enabled globally.\n');
  } else process.stdout.write('Cash on delivery already enabled globally.\n');
  process.stdout.write('Subscription settings were not changed.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Admin update failed'}\n`);
  process.exitCode = 1;
} finally {
  token = '';
  await app.close();
}
