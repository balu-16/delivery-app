import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { IdentityAuthorizer } from '../../identity/contracts/identity.js';
import {
  AGENT_DISCLOSURE_VERSION,
  type AgentChoiceReference,
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
import type { AgentJobs } from './jobs.js';

export class CustomerAgentService implements AgentOperations {
  constructor(
    private readonly settings: AgentConfiguration,
    private readonly identity: IdentityAuthorizer,
    private readonly threads: AgentThreads,
    private readonly runtime: AgentRuntime,
    private readonly privacy: AgentPrivacy,
    private readonly jobs: AgentJobs,
    private readonly workerEnabled: boolean,
  ) {}
  async onModuleInit(): Promise<void> {
    if (this.workerEnabled) await this.jobs.start();
  }
  config(_locale: AgentLocale = 'en'): Promise<AgentConfigView> {
    return this.settings.view('en');
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
  async current(userId: string, _locale: AgentLocale = 'en') {
    await this.authorize(userId);
    return this.threads.current(userId, 'en');
  }
  async create(userId: string, _locale: AgentLocale = 'en') {
    await this.authorize(userId);
    return this.threads.create(userId, 'en');
  }
  async listThreads(userId: string, cursor?: string) {
    await this.authorize(userId);
    return this.threads.list(userId, cursor);
  }
  async thread(userId: string, threadId: string) {
    await this.authorize(userId);
    const owned = await this.threads.owned(userId, threadId);
    return {
      id: threadId,
      status: owned.status,
      ...(await this.threads.messages(userId, threadId)),
    };
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
      choice?: AgentChoiceReference;
      locale: AgentLocale;
      signal: AbortSignal;
    },
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    await this.assertAllowed(input.userId, input.threadId);
    if (await this.runtime.tryLocalReply(input, emit)) return;
    const job = await this.jobs.submitMessage({ ...input, locale: 'en' });
    await this.jobs.follow(input.userId, input.threadId, job.id, undefined, input.signal, emit);
  }
  async resume(
    input: {
      userId: string;
      threadId: string;
      draftId: string;
      decision: 'approve' | 'reject';
      clientActionId?: string;
      locale: AgentLocale;
      signal: AbortSignal;
    },
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    await this.assertAllowed(input.userId, input.threadId);
    const job = await this.jobs.submitResume({ ...input, locale: 'en' });
    await this.jobs.follow(input.userId, input.threadId, job.id, undefined, input.signal, emit);
  }
  async cancel(userId: string, threadId: string): Promise<void> {
    await this.threads.owned(userId, threadId);
    await this.jobs.cancel(userId, threadId);
    await this.runtime.cancel(userId, threadId);
  }
  async currentRun(userId: string, threadId: string) {
    await this.assertAllowed(userId, threadId);
    return this.jobs.current(userId, threadId);
  }
  async followRun(
    userId: string,
    threadId: string,
    runId: string,
    after: string | undefined,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    await this.assertAllowed(userId, threadId);
    await this.jobs.follow(userId, threadId, runId, after, signal, emit);
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
    clientActionId?: string,
  ): Promise<unknown> {
    await this.assertAllowed(userId, threadId);
    return this.runtime.action({ userId, threadId, cardId, action, payload, clientActionId });
  }
  async onModuleDestroy(): Promise<void> {
    await this.jobs.stop();
    await this.runtime.close();
  }
}
