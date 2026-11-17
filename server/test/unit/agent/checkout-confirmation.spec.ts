import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { jest } from '@jest/globals';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { createConfirmTools } from '../../../src/modules/agent/infrastructure/confirm-tools.js';
import type { AgentDrafts, DraftRecord } from '../../../src/modules/agent/infrastructure/drafts.js';
import { ScriptedChatModel } from '../../../src/modules/agent/infrastructure/llm/fake-model.js';
import type { AgentOrderPlacement } from '../../../src/modules/agent/infrastructure/placement.js';
import { AgentToolKit } from '../../../src/modules/agent/infrastructure/tool-kit.js';

const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  thread: '10000000-0000-4000-8000-000000000002',
  draft: '10000000-0000-4000-8000-000000000003',
  address: '10000000-0000-4000-8000-000000000004',
  variant: '10000000-0000-4000-8000-000000000005',
  quote: '10000000-0000-4000-8000-000000000006',
  intent: '10000000-0000-4000-8000-000000000007',
};

test.each(['approve', 'reject'] as const)(
  'order confirmation pauses before %s and only approval can place it',
  async (decision) => {
    const model = new ScriptedChatModel([
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'place-order-1', name: 'place_order', args: {}, type: 'tool_call' }],
      }),
      new AIMessage('Finished.'),
    ]);
    let saved: DraftRecord | null = null;
    const prepare = jest.fn(async (input: Parameters<AgentDrafts['prepare']>[0]) => {
      saved = {
        id: ids.draft,
        thread_id: input.threadId,
        user_id: input.userId,
        type: input.type,
        tool_call_id: input.toolCallId,
        payload: input.payload,
        payload_hash: 'test',
        status: 'pending',
        expires_at: input.expiresAt,
        result: null,
      };
      return saved;
    });
    const drafts = {
      byCall: jest.fn(async () => saved),
      prepare,
      stageDecision: jest.fn(async (input: { decision: 'approve' | 'reject' }) => ({
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        payload: saved!.payload,
        result: null,
      })),
    } as unknown as AgentDrafts;
    const execute = jest.fn(async () => ({ orderId: 'placed' }));
    const placement = { execute } as unknown as AgentOrderPlacement;
    const quote = jest.fn(async () => ({
      quote: {
        quoteId: ids.quote,
        issues: [],
        totalPaise: '12000',
        amountDuePaise: '12000',
        discountPaise: '0',
        taxTotalPaise: '0',
        wallet: null,
        lines: [{ variantId: ids.variant, quantity: '2', unitPricePaise: '6000' }],
        fees: [],
      },
      intentId: ids.intent,
      intentExpiresAt: new Date(Date.now() + 120000).toISOString(),
      codAvailable: true,
    }));
    const deps = {
      cart: {
        get: async () => ({
          addressId: ids.address,
          couponCode: null,
          lines: [{ variantId: ids.variant, productName: 'Milk', variantName: '1 litre' }],
        }),
      },
      addresses: { list: async () => [{ id: ids.address, line1: 'Street', pincode: '520001' }] },
      checkout: { quote },
      orders: {},
    } as unknown as Parameters<typeof createConfirmTools>[0];
    const tools = createConfirmTools(
      deps,
      drafts,
      placement,
      { userId: ids.user, threadId: ids.thread, confirmTtlSeconds: 60, maxOrderPaise: '500000' },
      new AgentToolKit(5),
    );
    const agent = createAgent({ model, tools, checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: `order-${decision}` } };
    const paused = await agent.invoke({ messages: [new HumanMessage('Place my order.')] }, config);
    expect(paused.__interrupt__).toBeDefined();
    expect(quote).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();

    await agent.invoke(new Command({ resume: { draftId: ids.draft, decision } }), config);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
  },
);
