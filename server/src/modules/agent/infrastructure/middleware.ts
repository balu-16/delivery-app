import { countTokensApproximately, createMiddleware, trimMessages } from 'langchain';
import type { BaseMessage } from '@langchain/core/messages';

const tokenCounter = (messages: BaseMessage[]): number => countTokensApproximately(messages);

/** Token-bounded history for every model call. The window starts at the newest customer
 * message, so tool-call chains inside the window stay complete; operator system notes are
 * carried as a suffix of the system message rather than graph state, so trimming cannot
 * drop them. */
export function historyTrimming(maxTokens: number, notes: readonly string[]) {
  const suffix = notes.length
    ? `\n<recent_notes>\n${notes.map((note) => `- ${note}`).join('\n')}\n</recent_notes>`
    : '';
  return createMiddleware({
    name: 'history-trimming',
    wrapModelCall: async (request, handler) => {
      const bounded = await trimMessages(request.messages, {
        maxTokens,
        tokenCounter,
        strategy: 'last',
        startOn: 'human',
      });
      return handler({
        ...request,
        messages: bounded,
        systemMessage: request.systemMessage.concat(suffix),
      });
    },
  });
}
