import { isReplayedConfirmation } from '../../../src/modules/agent/infrastructure/confirmation-events.js';
import type { AgentEvent } from '../../../src/modules/agent/contracts/agent.js';

test('a resumed draft is not shown or saved as a fresh confirmation', () => {
  const card: AgentEvent = {
    event: 'card',
    data: { cardId: 'card', type: 'order_confirm', payload: { draftId: 'first' } },
  };
  const required: AgentEvent = {
    event: 'draft.required',
    data: { draftId: 'first', type: 'order', expiresAt: '2030-01-01T00:00:00Z' },
  };
  expect(isReplayedConfirmation(card, 'first')).toBe(true);
  expect(isReplayedConfirmation(required, 'first')).toBe(true);
  expect(isReplayedConfirmation(card, 'second')).toBe(false);
  expect(isReplayedConfirmation(required, null)).toBe(false);
});
