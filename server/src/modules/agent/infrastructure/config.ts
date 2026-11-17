import type { ConfigService } from '../../../config/config.service.js';
import type { AdminConfig } from '../../app-config/contracts/config.js';
import {
  AGENT_DISCLOSURE_VERSION,
  type AgentConfigView,
  type AgentLocale,
} from '../contracts/agent.js';

const prompts: Record<AgentLocale, string[]> = {
  en: ['Show me milk', 'Where is my order?', 'Show my cart'],
  hi: ['मुझे दूध दिखाएं', 'मेरा ऑर्डर कहाँ है?', 'मेरा कार्ट दिखाएं'],
  te: ['పాలు చూపించండి', 'నా ఆర్డర్ ఎక్కడ ఉంది?', 'నా కార్ట్ చూపించండి'],
};

export class AgentConfiguration {
  constructor(
    private readonly runtime: ConfigService,
    private readonly config: AdminConfig,
  ) {}

  configured(): boolean {
    const provider = this.runtime.get('LLM_PROVIDER');
    if (
      this.runtime.get('AGENT_ENABLED') !== 'true' ||
      !provider ||
      this.runtime.get('LANGSMITH_TRACING') === 'true'
    )
      return false;
    if (provider === 'fake') return this.runtime.get('NODE_ENV') !== 'production';
    if (!this.runtime.get('LLM_MODEL')) return false;
    if (provider === 'bedrock') return true;
    if (provider === 'anthropic') return Boolean(this.runtime.get('ANTHROPIC_API_KEY'));
    if (provider === 'google') return Boolean(this.runtime.get('GOOGLE_API_KEY'));
    if (provider === 'nvidia') return Boolean(this.runtime.get('NVIDIA_API_KEY'));
    if (provider === 'openai_compatible' && !this.runtime.get('LLM_BASE_URL')) return false;
    return Boolean(this.runtime.get('OPENAI_API_KEY'));
  }

  async view(locale: AgentLocale = 'en'): Promise<AgentConfigView> {
    const enabled = this.configured() && (await this.config.flag('agent_enabled'));
    return {
      enabled,
      suggestedPrompts: prompts[locale],
      maxMessageChars: 2000,
      disclosureVersion: AGENT_DISCLOSURE_VERSION,
      supportedLocales: ['en', 'hi', 'te'],
    };
  }
}
