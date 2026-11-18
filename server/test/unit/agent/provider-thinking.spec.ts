import { jest } from '@jest/globals';
import { ConfigService } from '../../../src/config/config.service.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { messageDeltaText } from '../../../src/modules/agent/infrastructure/guards.js';
import { createAssistantModel } from '../../../src/modules/agent/infrastructure/llm/llm.factory.js';
import { AgentConfiguration } from '../../../src/modules/agent/infrastructure/config.js';
import type { AdminConfig } from '../../../src/modules/app-config/contracts/config.js';

const openAiResponse = () =>
  new Response(
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

const geminiResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: 'Hello.' }], role: 'model' }, finishReason: 'STOP', index: 0 },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      modelVersion: 'gemma-4-26b-a4b-it',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('assistant provider thinking configuration', () => {
  test.each([
    ['on', true],
    ['', undefined],
    ['off', undefined],
  ] as const)(
    'nvidia sends enable_thinking=%s in the chat template kwargs',
    async (mode, expected) => {
      let url = '',
        authorization = '',
        requestBody: Record<string, unknown> | undefined;
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = input instanceof Request && !init ? input : new Request(input, init);
        url = request.url;
        authorization = request.headers.get('authorization') ?? '';
        requestBody = (await request.json()) as Record<string, unknown>;
        return openAiResponse();
      });
      const env = readEnv({
        NODE_ENV: 'test',
        LLM_PROVIDER: 'nvidia',
        LLM_MODEL: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        NVIDIA_API_KEY: 'nvidia-synthetic-key',
        OPENAI_API_KEY: 'unused-synthetic-key',
        LLM_THINKING: mode,
      });
      const { model } = await createAssistantModel(new ConfigService(env));
      await model.invoke('Hello.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      // The NVIDIA key is used for NVIDIA and never substituted by another provider's key.
      expect(authorization).toBe('Bearer nvidia-synthetic-key');
      expect(requestBody?.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
      expect(requestBody?.chat_template_kwargs).toEqual(
        expected === undefined ? undefined : { enable_thinking: expected },
      );
      expect(requestBody?.top_p).toBe(0.95);
      expect(requestBody?.reasoning).toBeUndefined();
    },
  );

  test.each([
    ['on', /high/i],
    ['', null],
  ] as const)('google %s requests thinking with the configured level', async (mode, expected) => {
    let requestBody: Record<string, unknown> | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      requestBody = (await request.json()) as Record<string, unknown>;
      return geminiResponse();
    });
    const env = readEnv({
      NODE_ENV: 'test',
      LLM_PROVIDER: 'google',
      LLM_MODEL: 'gemma-4-26b-a4b-it',
      GOOGLE_API_KEY: 'google-synthetic-key',
      LLM_THINKING: mode,
    });
    const { model } = await createAssistantModel(new ConfigService(env));
    await model.invoke('Hello.');
    const generationConfig = (requestBody?.generationConfig ?? {}) as {
      thinkingConfig?: { thinkingLevel?: string };
    };
    if (expected === null) expect(generationConfig.thinkingConfig).toBeUndefined();
    else expect(String(generationConfig.thinkingConfig?.thinkingLevel)).toMatch(expected);
  });

  test('provider configuration requires the matching key', () => {
    const adminConfig = {} as AdminConfig;
    const base = { NODE_ENV: 'test', AGENT_ENABLED: 'true', LLM_MODEL: 'm' } as const;
    expect(
      new AgentConfiguration(
        new ConfigService(readEnv({ ...base, LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'k' })),
        adminConfig,
      ).configured(),
    ).toBe(true);
    expect(
      new AgentConfiguration(
        new ConfigService(readEnv({ ...base, LLM_PROVIDER: 'nvidia' })),
        adminConfig,
      ).configured(),
    ).toBe(false);
    expect(
      new AgentConfiguration(
        new ConfigService(readEnv({ ...base, LLM_PROVIDER: 'google', GOOGLE_API_KEY: 'k' })),
        adminConfig,
      ).configured(),
    ).toBe(true);
  });

  test('env validation confines thinking and base URLs to the providers that support them', () => {
    expect(() =>
      readEnv({
        LLM_PROVIDER: 'openai_compatible',
        LLM_BASE_URL: 'https://openrouter.ai/api/v1',
        LLM_THINKING: 'on',
      }),
    ).toThrow(/LLM_THINKING/);
    expect(() =>
      readEnv({ LLM_PROVIDER: 'nvidia', LLM_BASE_URL: 'http://integrate.api.nvidia.com/v1' }),
    ).toThrow(/LLM_BASE_URL/);
    expect(readEnv({}).LLM_THINKING).toBe('');
  });

  test('messageDeltaText exposes only visible text, never reasoning or tool data', () => {
    expect(messageDeltaText({ content: 'plain' })).toBe('plain');
    expect(
      messageDeltaText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'reasoning', reasoning: 'secret chain' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab');
    expect(
      messageDeltaText({ content: [{ type: 'reasoning-delta', reasoning: 'chain of thought' }] }),
    ).toBe('');
    expect(
      messageDeltaText({
        content: [
          { type: 'text', thought: true, text: 'internal deliberation' },
          { type: 'text', text: 'visible' },
        ],
      }),
    ).toBe('visible');
    expect(messageDeltaText({ additional_kwargs: { reasoning_content: 'hidden reasoning' } })).toBe(
      '',
    );
    expect(messageDeltaText(undefined)).toBe('');
    expect(messageDeltaText({ content: [{ type: 'tool_use', args: { id: 'x' } }] })).toBe('');
  });
});
