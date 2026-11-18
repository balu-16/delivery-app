import type { AgentThread } from './types';

/** Only a refreshed, server-owned draft can resolve an uncertain decision. */
export function decisionWasRecorded(thread: AgentThread, draftId: string, decision: 'approve' | 'reject'): boolean {
  const expected = decision === 'approve' ? 'executed' : 'rejected';
  return thread.messages.some(message => message.cards.some(card =>
    card.payload.draftId === draftId && card.payload.status === expected,
  ));
}
