import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { ModelRequest } from 'langchain';
import { historyTrimming } from '../../../src/modules/agent/infrastructure/middleware.js';

const longText = (text: string) => `x${'y'.repeat(200)} ${text}`;

describe('history trimming middleware', () => {
  const middleware = historyTrimming(400, [
    'Checked the delivery address.',
    'Added an item from a product card.',
  ]) as unknown as {
    wrapModelCall: (
      request: ModelRequest,
      handler: (request: ModelRequest) => Promise<AIMessage>,
    ) => Promise<AIMessage>;
  };

  const run = async (messages: unknown[]) => {
    const seen: { messages: unknown[]; system: string }[] = [];
    await middleware.wrapModelCall(
      {
        messages: messages as never,
        systemMessage: new SystemMessage('base prompt'),
        systemPrompt: '',
      } as unknown as ModelRequest,
      async (request) => {
        seen.push({
          messages: [...(request.messages as unknown[])],
          system: String((request.systemMessage as SystemMessage).content),
        });
        return new AIMessage('ok');
      },
    );
    return seen[0]!;
  };

  test('leaves a short history untouched and appends operator notes to the system message', async () => {
    const messages = [new HumanMessage('hello'), new AIMessage('hi')];
    const seen = await run(messages);
    expect(seen!.messages).toHaveLength(2);
    expect(seen.system).toContain('base prompt');
    expect(seen.system).toContain('- Checked the delivery address.');
    expect(seen.system).toContain('</recent_notes>');
  });

  test('trims an oversized history to start at the newest customer message', async () => {
    const tight = historyTrimming(100, []) as unknown as typeof middleware;
    const chain = [
      new HumanMessage(longText('old question')),
      new AIMessage({
        content: '',
        tool_calls: [
          { name: 'search_products', args: { query: 'milk' }, id: 't1', type: 'tool_call' },
        ],
      }),
      new ToolMessage({ content: longText('tool result for the old turn'), tool_call_id: 't1' }),
      new AIMessage(longText('old answer')),
      new HumanMessage('2 packets of milk please'),
    ];
    const seen: { messages: unknown[] }[] = [];
    await tight.wrapModelCall(
      {
        messages: chain as never,
        systemMessage: new SystemMessage('base'),
        systemPrompt: '',
      } as unknown as ModelRequest,
      async (request) => {
        seen.push({ messages: [...(request.messages as unknown[])] });
        return new AIMessage('ok');
      },
    );
    expect(seen[0]!.messages).toHaveLength(1);
    expect((seen[0]!.messages[0]! as HumanMessage).content).toBe('2 packets of milk please');
  });

  test('keeps a complete tool chain of the current turn', async () => {
    const chain = [
      new HumanMessage('2 packets of milk please'),
      new AIMessage({
        content: '',
        tool_calls: [
          { name: 'search_products', args: { query: 'milk' }, id: 't1', type: 'tool_call' },
        ],
      }),
      new ToolMessage({ content: longText('search results'), tool_call_id: 't1' }),
      new AIMessage(longText('found them, shall I confirm?')),
    ];
    const seen = await run(chain);
    expect(seen!.messages.length).toBe(4);
    expect((seen!.messages[0]! as HumanMessage).content).toBe('2 packets of milk please');
  });
});
