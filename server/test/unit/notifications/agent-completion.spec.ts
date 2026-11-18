import { planForEvent } from '../../../src/modules/notifications/domain/matrix.js';

const userId = '018f0000-0000-7000-8000-000000000001';
const threadId = '018f0000-0000-7000-8000-000000000002';
const aggregateId = '018f0000-0000-7000-8000-000000000003';

test.each([
  ['AGENT_RUN_READY', 'agent.reply_ready'],
  ['AGENT_RUN_WAITING', 'agent.needs_you'],
  ['AGENT_RUN_FAILED', 'agent.run_failed'],
])('routes %s to a private assistant push', (eventType, templateKey) => {
  const plan = planForEvent({
    eventType,
    aggregateId,
    aggregateVersion: '1',
    payload: { userId, threadId, secret: 'do not copy' },
  });
  expect(plan).toMatchObject({
    templateKey,
    category: 'ASSISTANT_UPDATES',
    class: 'TRANSACTIONAL',
    recipients: 'USER',
    channels: ['PUSH'],
    deepLink: '/agent',
    data: { threadId },
  });
  expect(JSON.stringify(plan)).not.toContain('do not copy');
});

test('does not produce an assistant push without both owner and conversation', () => {
  expect(
    planForEvent({
      eventType: 'AGENT_RUN_READY',
      aggregateId,
      aggregateVersion: '1',
      payload: { threadId },
    }),
  ).toBeNull();
  expect(
    planForEvent({
      eventType: 'AGENT_RUN_READY',
      aggregateId,
      aggregateVersion: '1',
      payload: { userId },
    }),
  ).toBeNull();
});
