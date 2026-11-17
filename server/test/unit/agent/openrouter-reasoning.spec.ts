import { jest } from '@jest/globals';
import { ConfigService } from '../../../src/config/config.service.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { createAssistantModel } from '../../../src/modules/agent/infrastructure/llm/llm.factory.js';

describe('OpenRouter reasoning configuration', () => {
  test.each([
    ['on', { enabled: true }],
    ['off', { enabled: false }],
    ['provider_default', undefined],
  ] as const)('sends the %s setting in the model request', async (mode, expected) => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      requestBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'synthetic-response',
          object: 'chat.completion',
          created: 0,
          model: 'synthetic',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello.' } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const env = readEnv({
      NODE_ENV: 'test',
      LLM_PROVIDER: 'openai_compatible',
      LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      LLM_MODEL: 'nvidia/nemotron-3.5-super-vl:free',
      OPENAI_API_KEY: 'synthetic-key',
      OPENROUTER_REASONING: mode,
    });
    const { model } = await createAssistantModel(new ConfigService(env));
    await model.invoke('Hello.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody?.model).toBe('nvidia/nemotron-3.5-super-vl:free');
    expect(requestBody?.reasoning).toEqual(expected);
  });

  test('rejects explicit OpenRouter settings for unrelated providers or endpoints', () => {
    expect(() => readEnv({ LLM_PROVIDER: 'openai', OPENROUTER_REASONING: 'on' })).toThrow(
      /OPENROUTER_REASONING/,
    );
    expect(() =>
      readEnv({
        LLM_PROVIDER: 'openai_compatible',
        LLM_BASE_URL: 'https://example.test/v1',
        OPENROUTER_REASONING: 'on',
      }),
    ).toThrow(/OPENROUTER_REASONING/);
    expect(readEnv({}).OPENROUTER_REASONING).toBe('provider_default');
  });
});
