import { decisionWasRecorded } from '../src/agent/confirmation-recovery';
import type { AgentThread } from '../src/agent/types';

const thread = (status: string, draftId = 'draft-1') => ({
  id: 'thread-1', status: 'active', nextCursor: null,
  messages: [{ id: 'message-1', role: 'assistant', text: '', createdAt: '2026-01-01T00:00:00Z', cards: [
    { cardId: draftId, type: 'order_confirm', payload: { draftId, status } },
  ] }],
} as AgentThread);

test('a refreshed executed draft confirms a decision after a lost response', () => {
  expect(decisionWasRecorded(thread('executed'), 'draft-1', 'approve')).toBe(true);
  expect(decisionWasRecorded(thread('rejected'), 'draft-1', 'reject')).toBe(true);
});

test('a pending, stale, or different draft cannot be mistaken for a completed order', () => {
  expect(decisionWasRecorded(thread('pending'), 'draft-1', 'approve')).toBe(false);
  expect(decisionWasRecorded(thread('stale'), 'draft-1', 'approve')).toBe(false);
  expect(decisionWasRecorded(thread('executed', 'other-draft'), 'draft-1', 'approve')).toBe(false);
});
