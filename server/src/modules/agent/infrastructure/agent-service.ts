import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { IdentityAuthorizer } from '../../identity/contracts/identity.js';
import {
  AGENT_DISCLOSURE_VERSION,
  type AgentConfigView,
  type AgentEvent,
  type AgentLocale,
  type AgentOperations,
} from '../contracts/agent.js';
import type { AgentConfiguration } from './config.js';
import type { AgentThreads } from './threads.js';
import { sanitizeAgentText } from './guards.js';
import type { AgentRuntime } from './runtime.js';
import type { AgentPrivacy } from '../contracts/privacy.js';

export class CustomerAgentService implements AgentOperations {
  constructor(
    private readonly settings: AgentConfiguration,
    private readonly identity: IdentityAuthorizer,
    private readonly threads: AgentThreads,
    private readonly runtime: AgentRuntime,
    private readonly privacy: AgentPrivacy,
  ) {}
  config(locale: AgentLocale = 'en'): Promise<AgentConfigView> {
    return this.settings.view(locale);
  }
  private async authorize(userId: string): Promise<void> {
    if (!(await this.settings.view()).enabled)
      throw new ServiceUnavailableException({ code: 'AGENT_NOT_CONFIGURED' });
    if (!(await this.identity.hasConsent(userId, 'ai_assistant', AGENT_DISCLOSURE_VERSION)))
      throw new ForbiddenException({ code: 'CONSENT_REQUIRED' });
  }
  async assertAllowed(userId: string, threadId?: string): Promise<void> {
    await this.authorize(userId);
    if (threadId) await this.threads.owned(userId, threadId);
  }
  async current(userId: string, locale: AgentLocale = 'en') {
    await this.authorize(userId);
    return this.threads.current(userId, locale);
  }
  async create(userId: string, locale: AgentLocale = 'en') {
    await this.authorize(userId);
    return this.threads.create(userId, locale);
  }
  async messages(userId: string, threadId: string, cursor?: string) {
    await this.authorize(userId);
    const result = await this.threads.messages(userId, threadId, cursor);
    return { items: result.messages, nextCursor: result.nextCursor };
  }
  async feedback(
    userId: string,
    messageId: string,
    rating: 'up' | 'down',
    reason?: string,
  ): Promise<void> {
    await this.authorize(userId);
    await this.threads.feedback(
      userId,
      messageId,
      rating,
      reason === undefined ? undefined : sanitizeAgentText(reason, 500),
    );
  }
  async run(
    input: {
      userId: string;
      threadId: string;
      clientMessageId: string;
      text: string;
      locale: AgentLocale;
      signal: AbortSignal;
    },
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    await this.assertAllowed(input.userId, input.threadId);
    await this.runtime.run(input, emit);
  }
  async resume(
    input: {
      userId: string;
      threadId: string;
      draftId: string;
      decision: 'approve' | 'reject';
      locale: AgentLocale;
      signal: AbortSignal;
    },
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    await this.assertAllowed(input.userId, input.threadId);
    await this.runtime.resume(input, emit);
  }
  async cancel(userId: string, threadId: string): Promise<void> {
    await this.assertAllowed(userId, threadId);
    await this.runtime.cancel(userId, threadId);
  }
  async deleteThread(userId: string, threadId: string): Promise<void> {
    await this.privacy.deleteThread(userId, threadId);
  }
  async deleteAllThreads(userId: string): Promise<void> {
    await this.privacy.deleteAllThreads(userId);
  }
  async action(
    userId: string,
    threadId: string,
    cardId: string,
    action: string,
    payload: unknown,
  ): Promise<unknown> {
    await this.assertAllowed(userId, threadId);
    return this.runtime.action({ userId, threadId, cardId, action, payload });
  }
  async onModuleDestroy(): Promise<void> {
    await this.runtime.close();
  }
}
