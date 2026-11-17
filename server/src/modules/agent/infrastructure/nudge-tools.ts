import { z } from 'zod';
import type { AgentNudges } from './nudges.js';
import type { AgentToolKit } from './tool-kit.js';

export function createNudgeTools(
  deps: { nudges: AgentNudges },
  context: { userId: string; threadId: string },
  kit: AgentToolKit,
) {
  return [
    kit.define(
      'set_reorder_nudges',
      'Turn this customer’s periodic restock reminders on or off, when they ask to start or stop reorder reminders.',
      z.object({
        enabled: z.boolean().describe('True turns restock reminders on; false turns them off'),
      }),
      async (input, runtime) =>
        deps.nudges.setPreference(
          context.userId,
          input.enabled,
          context.threadId,
          runtime.toolCallId,
        ),
    ),
  ];
}
