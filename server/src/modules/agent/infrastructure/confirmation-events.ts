import type { AgentEvent } from '../contracts/agent.js';

/** The graph replays an interrupted tool when its existing draft is resumed. */
export function isReplayedConfirmation(event: AgentEvent, draftId: string | null): boolean {
  if (!draftId) return false;
  return (
    (event.event === 'draft.required' && event.data.draftId === draftId) ||
    (event.event === 'card' && event.data.payload?.draftId === draftId)
  );
}
