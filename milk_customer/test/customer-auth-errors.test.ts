/// <reference types="jest" />
import { AuthError, cognitoRequest } from '../src/auth/cognito';
import { authErrorMessage } from '../src/auth/messages';
import { ApiError } from '../src/api/client';

const fetchMock = jest.fn();
const original = { fetch: globalThis.fetch, region: process.env.EXPO_PUBLIC_COGNITO_REGION, client: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID };

beforeEach(() => {
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
});
afterAll(() => {
  globalThis.fetch = original.fetch;
  process.env.EXPO_PUBLIC_COGNITO_REGION = original.region;
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = original.client;
});

test.each([
  ['NotAuthorizedException', 'INVALID_CREDENTIALS'],
  ['UserNotFoundException', 'INVALID_CREDENTIALS'],
  ['UserNotConfirmedException', 'EMAIL_NOT_VERIFIED'],
  ['UsernameExistsException', 'ACCOUNT_EXISTS'],
  ['InvalidPasswordException', 'INVALID_PASSWORD'],
  ['CodeMismatchException', 'INVALID_CODE'],
  ['ExpiredCodeException', 'EXPIRED_CODE'],
  ['TooManyRequestsException', 'RATE_LIMITED'],
  ['PasswordResetRequiredException', 'RESET_REQUIRED'],
])('maps %s without showing the provider message', async (provider, expected) => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ __type: `aws.cognito#${provider}`, message: 'private provider detail' }), { status: 400 }));
  await expect(cognitoRequest('InitiateAuth', {})).rejects.toMatchObject({ code: expected });
  try { await cognitoRequest('InitiateAuth', {}); } catch (error) {
    expect(authErrorMessage(error)).not.toContain('private provider detail');
  }
});

test('tells the user which service is unreachable without exposing the network error', async () => {
  fetchMock.mockRejectedValue(new Error('secret network diagnostic'));
  await expect(cognitoRequest('InitiateAuth', {})).rejects.toMatchObject({ code: 'COGNITO_UNREACHABLE' });
  expect(authErrorMessage(new AuthError('BACKEND_UNREACHABLE'))).toContain('customer server');
  expect(authErrorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE', 'trace'))).toContain('temporarily unavailable');
});

test('unknown provider failures never expose raw messages', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ __type: 'SomeNewException', message: 'private detail' }), { status: 500 }));
  await expect(cognitoRequest('SignUp', {})).rejects.toMatchObject({ code: 'COGNITO_UNAVAILABLE' });
});

test('an unresponsive sign-in service times out with a useful connection error', async () => {
  jest.useFakeTimers();
  try {
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const request = cognitoRequest('InitiateAuth', {});
    jest.advanceTimersByTime(20000);
    await expect(request).rejects.toMatchObject({ code: 'COGNITO_UNREACHABLE' });
  } finally { jest.useRealTimers(); }
});

test('password recovery does not ask the user to check a password they were not asked to enter', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({__type:'UserNotFoundException'}), {status:400}));
  await expect(cognitoRequest('ForgotPassword', {})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
