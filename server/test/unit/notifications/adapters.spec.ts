import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';
import type { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Transporter } from 'nodemailer';
import { FcmPush } from '../../../src/adapters/push/fcm-push.js';
import { SesEmail } from '../../../src/adapters/email/ses-email.js';
import { SmtpEmail } from '../../../src/adapters/email/smtp-email.js';
import { DisabledSms } from '../../../src/adapters/sms/disabled.js';

const jest = import.meta.jest;

// Firebase specifies at most 500 targets and response order matching input:
// https://firebase.google.com/docs/cloud-messaging/send/admin-sdk
const payload = {
  title: 'Title',
  body: 'Body',
  deepLink: '/orders/1',
  data: { collapseKey: 'notice-1', id: '1' },
  priority: 'HIGH' as const,
};
const email = {
  to: 'recipient@example.test',
  subject: 'नमस्ते',
  body: 'Hello',
  messageId: 'stable-id',
};

test('FCM sends bounded multicast with stable collapse controls and maps ordered outcomes', async () => {
  const send = jest.fn<Promise<BatchResponse>, [MulticastMessage]>().mockResolvedValue({
    successCount: 1,
    failureCount: 2,
    responses: [
      { success: true, messageId: 'provider-1' },
      { success: false, error: { code: 'messaging/registration-token-not-registered' } as never },
      { success: false, error: { code: 'messaging/server-unavailable' } as never },
    ],
  });
  const adapter = new FcmPush('{}', { sendEachForMulticast: send });
  const result = await adapter.send(['one', 'two', 'three'], payload);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      tokens: ['one', 'two', 'three'],
      notification: { title: 'Title', body: 'Body' },
      data: { collapseKey: 'notice-1', id: '1', link: '/orders/1', clickAction: '/orders/1' },
      android: {
        priority: 'high',
        collapseKey: 'notice-1',
        notification: { channelId: 'default' },
      },
      apns: { headers: { 'apns-priority': '10', 'apns-collapse-id': 'notice-1' } },
    }),
  );
  expect(result).toEqual([
    {
      token: 'one',
      ok: true,
      invalidToken: false,
      retryable: true,
      messageId: 'provider-1',
      error: null,
    },
    {
      token: 'two',
      ok: false,
      invalidToken: true,
      retryable: false,
      messageId: null,
      error: 'messaging/registration-token-not-registered',
    },
    {
      token: 'three',
      ok: false,
      invalidToken: false,
      retryable: true,
      messageId: null,
      error: 'messaging/server-unavailable',
    },
  ]);
  await expect(adapter.send([], payload)).rejects.toThrow('INVALID_INPUT');
  await expect(adapter.send(Array(501).fill('token'), payload)).rejects.toThrow('INVALID_INPUT');
  await adapter.send(Array(500).fill('token'), payload);
  await adapter.send(['web-installation-id'], payload, 'FID');
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ tokens: [], fids: ['web-installation-id'] }),
  );
  expect(send).toHaveBeenCalledTimes(3);
});

test('FCM limits rider-offer delivery to the remaining offer lifetime', async () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const send = jest.fn<Promise<BatchResponse>, [MulticastMessage]>().mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    responses: [{ success: true, messageId: 'one' }],
  });
  await new FcmPush('{}', { sendEachForMulticast: send }).send(['token'], {
    ...payload,
    data: { ...payload.data, expiresAt: '2030-01-01T00:00:30.000Z' },
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ android: expect.objectContaining({ ttl: 30000 }) }),
  );
});

test('FCM rejects malformed credentials and wraps transport failures', async () => {
  expect(() => new FcmPush('{bad')).toThrow('INVALID_FCM_SERVICE_ACCOUNT');
  const send = jest
    .fn<Promise<BatchResponse>, [MulticastMessage, boolean?]>()
    .mockRejectedValue(new Error('network secret'));
  await expect(
    new FcmPush('{}', { sendEachForMulticast: send }).send(['token'], payload),
  ).rejects.toThrow('ExternalServiceUnavailable');
});

test('FCM preserves retry-after for quota failures without exposing provider details', async () => {
  const send = jest.fn<Promise<BatchResponse>, [MulticastMessage]>().mockResolvedValue({
    successCount: 0,
    failureCount: 1,
    responses: [
      { success: false, error: { code: 'messaging/quota-exceeded', retryAfter: '120' } as never },
    ],
  });
  const [result] = await new FcmPush('{}', { sendEachForMulticast: send }).send(
    ['fid-123'],
    payload,
    'FID',
  );
  expect(result).toMatchObject({ token: 'fid-123', retryable: true, retryAfterMs: 120000 });
});

test('SES supplies UTF-8 command, recipient, sender and bounded abort signal; failures are sanitized', async () => {
  const send = jest
    .fn<Promise<{ MessageId: string }>, [SendEmailCommand, { abortSignal: AbortSignal }]>()
    .mockResolvedValue({ MessageId: 'ses-1' });
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  const adapter = new SesEmail('ap-south-1', 'sender@example.test', { send } as unknown as Pick<
    SESv2Client,
    'send'
  >);
  expect(await adapter.send(email)).toEqual({ messageId: 'ses-1' });
  const [command, options] = send.mock.calls[0]!;
  expect(command.input).toEqual({
    FromEmailAddress: 'sender@example.test',
    Destination: { ToAddresses: [email.to] },
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: email.body, Charset: 'UTF-8' } },
      },
    },
  });
  expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  expect(timeout).toHaveBeenCalledWith(10000);
  timeout.mockRestore();
  send.mockRejectedValueOnce(new Error('private details'));
  await expect(adapter.send(email)).rejects.toThrow('ExternalServiceUnavailable');
});

test('SMTP configures timeouts, stable message ID, and sanitizes transport failures', async () => {
  const sendMail = jest
    .fn<Promise<{ messageId: string }>, [unknown]>()
    .mockResolvedValue({ messageId: '<provider>' });
  const close = jest.fn();
  const createTransport = jest.fn(() => ({ sendMail, close }) as unknown as Transporter);
  const adapter = new SmtpEmail('smtp://localhost:1025', 'sender@example.test', createTransport);
  expect(createTransport).toHaveBeenCalledWith({
    url: 'smtp://localhost:1025',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  expect(await adapter.send(email)).toEqual({ messageId: '<provider>' });
  expect(sendMail).toHaveBeenCalledWith({
    from: 'sender@example.test',
    to: email.to,
    messageId: '<stable-id@delivery.local>',
    subject: email.subject,
    text: email.body,
  });
  sendMail.mockRejectedValueOnce(new Error('private details'));
  await expect(adapter.send(email)).rejects.toThrow('ExternalServiceUnavailable');
  await adapter.close();
  expect(close).toHaveBeenCalled();
});

test('SMS remains explicitly disabled', async () => {
  await expect(new DisabledSms().send('recipient', 'template', {})).rejects.toThrow(
    'FEATURE_DISABLED',
  );
});
