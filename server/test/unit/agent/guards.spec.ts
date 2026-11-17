import { AIMessage } from '@langchain/core/messages';
import {
  assertPendingDraft,
  assertQuantity,
  draftHash,
  sanitizeAgentText,
} from '../../../src/modules/agent/infrastructure/guards.js';
import { ScriptedChatModel } from '../../../src/modules/agent/infrastructure/llm/fake-model.js';
import { readEnv } from '../../../src/config/env.schema.js';

describe('customer assistant safeguards', () => {
  test('sanitizes untrusted control characters and markup', () => {
    expect(sanitizeAgentText('  <b>Milk</b>\u0000  ')).toBe('Milk');
    expect(sanitizeAgentText('abcdef', 3)).toBe('abc');
  });
  test.each([-1, 0, 0.5, 1000000, Number.NaN])('rejects unsafe quantity %s', (quantity) => {
    expect(() => assertQuantity(quantity, 10)).toThrow('INVALID_QUANTITY');
  });
  test('accepts zero only when removing an item', () => {
    expect(() => assertQuantity(0, 10, true)).not.toThrow();
    expect(() => assertQuantity(10, 10)).not.toThrow();
  });
  test('hashes equivalent JSON consistently and detects payload changes', () => {
    const payload = { total: '5000', items: [{ id: 'a', quantity: 2 }] };
    const hash = draftHash(payload);
    expect(draftHash({ items: [{ quantity: 2, id: 'a' }], total: '5000' })).toBe(hash);
    expect(() =>
      assertPendingDraft('pending', new Date('2030-01-01'), hash, payload, new Date('2029-01-01')),
    ).not.toThrow();
    expect(() =>
      assertPendingDraft(
        'pending',
        new Date('2030-01-01'),
        hash,
        { ...payload, total: '1' },
        new Date('2029-01-01'),
      ),
    ).toThrow('DRAFT_INVALID');
    expect(() =>
      assertPendingDraft('pending', new Date('2029-01-01'), hash, payload, new Date('2029-01-01')),
    ).toThrow('DRAFT_EXPIRED');
    expect(() =>
      assertPendingDraft(
        'superseded',
        new Date('2030-01-01'),
        hash,
        payload,
        new Date('2029-01-01'),
      ),
    ).toThrow('DRAFT_NOT_PENDING');
  });
  test('starts with no model configuration and refuses production fake model', () => {
    expect(readEnv({}).AGENT_ENABLED).toBe('false');
    expect(() =>
      readEnv({ NODE_ENV: 'production', AGENT_ENABLED: 'true', LLM_PROVIDER: 'fake' }),
    ).toThrow(/LLM_PROVIDER/);
  });
  test('scripted model returns deterministic LangChain messages', async () => {
    const model = new ScriptedChatModel([new AIMessage('Scripted response')]);
    expect((await model.invoke('hello')).content).toBe('Scripted response');
  });
});
