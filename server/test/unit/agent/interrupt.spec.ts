import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver, interrupt } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { ScriptedChatModel } from '../../../src/modules/agent/infrastructure/llm/fake-model.js';
import { AgentToolKit } from '../../../src/modules/agent/infrastructure/tool-kit.js';

test('the shared wrapper preserves LangGraph interrupts and resumes only after approval', async () => {
  const model = new ScriptedChatModel([
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'confirm_action', args: {}, type: 'tool_call' }],
    }),
    new AIMessage('Finished.'),
  ]);
  let effects = 0;
  const kit = new AgentToolKit(5);
  const confirm = kit.define(
    'confirm_action',
    'Ask for a test confirmation.',
    z.object({}),
    async () => {
      const decision: unknown = interrupt({ draftId: 'draft-1' });
      if (decision === 'approve') effects += 1;
      return { approved: decision === 'approve' };
    },
  );
  const agent = createAgent({ model, tools: [confirm], checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'approval-test' } };
  const paused = await agent.invoke(
    { messages: [new HumanMessage('Confirm this action.')] },
    config,
  );
  expect(paused.__interrupt__).toBeDefined();
  expect(effects).toBe(0);
  await agent.invoke(new Command({ resume: 'approve' }), config);
  expect(effects).toBe(1);
});
