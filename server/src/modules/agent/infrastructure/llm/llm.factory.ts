import { initChatModel } from 'langchain';
import type { ConfigService } from '../../../../config/config.service.js';
import { ScriptedChatModel } from './fake-model.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

function apiKeyFor(provider: string, config: ConfigService): string {
  if (provider === 'bedrock') return '';
  if (provider === 'anthropic') return config.get('ANTHROPIC_API_KEY');
  if (provider === 'google') return config.get('GOOGLE_API_KEY');
  if (provider === 'nvidia') return config.get('NVIDIA_API_KEY');
  return config.get('OPENAI_API_KEY');
}

/** Provider-specific configuration is confined to this factory. */
export async function createAssistantModel(config: ConfigService) {
  const provider = config.get('LLM_PROVIDER');
  if (!provider) throw new Error('AGENT_NOT_CONFIGURED');
  if (provider === 'fake') {
    if (config.get('NODE_ENV') === 'production') throw new Error('FAKE_MODEL_IN_PRODUCTION');
    return { model: new ScriptedChatModel(), fallback: undefined };
  }
  const model = config.get('LLM_MODEL');
  if (!model) throw new Error('AGENT_NOT_CONFIGURED');
  const modelProvider =
    provider === 'openai_compatible' || provider === 'nvidia' ? 'openai' : provider;
  const apiKey = apiKeyFor(provider, config);
  if (provider !== 'bedrock' && !apiKey) throw new Error('AGENT_NOT_CONFIGURED');
  const thinking = config.get('LLM_THINKING') === 'on';
  const options = {
    modelProvider,
    temperature: config.get('LLM_TEMPERATURE'),
    maxTokens: config.get('LLM_MAX_OUTPUT_TOKENS'),
    timeout: config.get('LLM_TIMEOUT_MS'),
    maxRetries: config.get('LLM_MAX_RETRIES'),
    ...(apiKey ? { apiKey } : {}),
    ...(provider === 'openai_compatible'
      ? { configuration: { baseURL: config.get('LLM_BASE_URL') } }
      : {}),
    ...(provider === 'nvidia'
      ? { configuration: { baseURL: config.get('LLM_BASE_URL') || NVIDIA_BASE_URL }, topP: 0.95 }
      : {}),
    ...(provider === 'openai_compatible' &&
    config.get('OPENROUTER_REASONING') !== 'provider_default'
      ? { modelKwargs: { reasoning: { enabled: config.get('OPENROUTER_REASONING') === 'on' } } }
      : {}),
    // NVIDIA thinking arrives through the endpoint's chat template; never sent to other providers.
    ...(provider === 'nvidia' && thinking
      ? { modelKwargs: { chat_template_kwargs: { enable_thinking: true } } }
      : {}),
    ...(provider === 'google' && thinking ? { thinkingLevel: 'high' } : {}),
    ...(provider === 'bedrock' ? { region: config.get('AWS_REGION') } : {}),
  };
  if (provider === 'openai_compatible' && !config.get('LLM_BASE_URL'))
    throw new Error('AGENT_NOT_CONFIGURED');
  const primary = await initChatModel(model, options);
  if (typeof primary.bindTools !== 'function') throw new Error('MODEL_TOOL_CALLING_UNAVAILABLE');
  const fallback = config.get('LLM_FALLBACK_MODEL');
  return {
    model: primary,
    fallback: fallback ? await initChatModel(fallback, options) : undefined,
  };
}
