import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { createAgent, modelFallbackMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { isReplayedConfirmation } from './confirmation-events.js';
import pg from 'pg';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import type { Database } from '../../../platform/database/database.js';
import type { ConfigService } from '../../../config/config.service.js';
import { postgresConnectionConfig } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { AddressOperations } from '../../addresses/contracts/addresses.js';
import type { CartService } from '../../cart/contracts/cart.js';
import type { CatalogQuery } from '../../catalog/contracts/catalog.js';
import type { OrderOperations } from '../../orders/contracts/orders.js';
import type { WalletViews } from '../../wallet/contracts/wallet.js';
import type { Support } from '../../support/contracts/support.js';
import type { CheckoutOperations } from '../../checkout/contracts/checkout.js';
import type { AgentCard, AgentEvent, AgentLocale } from '../contracts/agent.js';
import type { CustomerTracking } from '../../dispatch/contracts/tasks.js';
import type { Serviceability } from '../../serviceability/contracts/serviceability.js';
import type { CouponValidation } from '../../coupons/contracts/coupons.js';
import { createAssistantModel } from './llm/llm.factory.js';
import { createReadTools } from './read-tools.js';
import { AgentToolKit } from './tool-kit.js';
import { createWriteTools } from './write-tools.js';
import { createConfirmTools } from './confirm-tools.js';
import { AgentDrafts } from './drafts.js';
import { AgentOrderPlacement } from './placement.js';
import { AgentActions } from './actions.js';
import { messageDeltaText, sanitizeAgentText } from './guards.js';
import { historyTrimming } from './middleware.js';
import { createNudgeTools } from './nudge-tools.js';
import { SYSTEM_PROMPT, PROMPT_VERSION } from './prompts/system.base.v1.js';
import type { AgentNudges } from './nudges.js';
import type { AgentRuns } from './runs.js';
import type { AgentThreads } from './threads.js';

type Emit = (event: AgentEvent) => void;
/** Token usage reported by the provider for the run's final model call. */
interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}
interface Dependencies {
  db: Database;
  addresses: AddressOperations;
  cart: CartService;
  catalog: CatalogQuery;
  orders: OrderOperations;
  wallet: WalletViews;
  support: Support;
  checkout: CheckoutOperations;
  tracking: CustomerTracking;
  serviceability: Serviceability;
  coupons: CouponValidation;
  nudges: AgentNudges;
}
const RELEASE =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
const RENEW =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";

function agentFailureCode(error: unknown, aborted: boolean): string {
  if (aborted || (error instanceof Error && error.message === 'RUN_ABORTED')) return 'RUN_ABORTED';
  const status = providerStatus(error);
  if (status === 429) return 'RATE_LIMITED';
  return 'AGENT_UNAVAILABLE';
}
function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; statusCode?: unknown; cause?: unknown };
  if (record.status === 429 || record.statusCode === 429) return 429;
  if (record.status === 503 || record.statusCode === 503) return 503;
  return providerStatus(record.cause);
}

/** The graph owns model/tool iteration and Postgres checkpointing. */
export class AgentRuntime {
  private readonly logger = new Logger(AgentRuntime.name);
  private readonly checkpointer: PostgresSaver;
  private readonly drafts: AgentDrafts;
  private readonly actions: AgentActions;
  private readonly placement: AgentOrderPlacement;
  constructor(
    private readonly config: ConfigService,
    private readonly appConfig: AppConfig,
    private readonly redis: Redis,
    private readonly runs: AgentRuns,
    private readonly threads: AgentThreads,
    private readonly deps: Dependencies,
  ) {
    const region = config.get('DATABASE_AUTH') === 'iam' ? config.get('AWS_REGION') : undefined;
    this.checkpointer = new PostgresSaver(
      new pg.Pool({
        ...postgresConnectionConfig(config.get('DATABASE_URL'), region),
        max: 4,
        connectionTimeoutMillis: config.get('DB_ACQUIRE_TIMEOUT_MS'),
      }),
    );
    this.drafts = new AgentDrafts(deps.db);
    this.actions = new AgentActions(deps);
    this.placement = new AgentOrderPlacement(deps.db, deps.checkout);
  }
  async close(): Promise<void> {
    await this.checkpointer.end();
  }

  private async createGraph(context: {
    userId: string;
    threadId: string;
    locale: AgentLocale;
    maxCalls: number;
    maxQuantity: number;
    ttl: number;
    maxOrderPaise: string;
    maxHistoryTokens: number;
    userText?: string;
    clientMessageId?: string;
  }) {
    const { model, fallback } = await createAssistantModel(this.config);
    const kit = new AgentToolKit(context.maxCalls);
    const tools = [
      ...createReadTools(
        { ...this.deps, appConfig: this.appConfig },
        { userId: context.userId, locale: context.locale },
        kit,
      ),
      ...createWriteTools(
        {
          ...this.deps,
          locationRequired: async () =>
            (
              await sql<{
                enabled: boolean;
              }>`SELECT enabled FROM feature_flags WHERE key='customer_location_required'`.execute(
                this.deps.db,
              )
            ).rows[0]?.enabled === true,
        },
        {
          userId: context.userId,
          threadId: context.threadId,
          maxQuantity: context.maxQuantity,
          userText: context.userText,
          clientMessageId: context.clientMessageId,
        },
        kit,
      ),
      ...createConfirmTools(
        this.deps,
        this.drafts,
        this.placement,
        {
          userId: context.userId,
          threadId: context.threadId,
          confirmTtlSeconds: context.ttl,
          maxOrderPaise: context.maxOrderPaise,
        },
        kit,
      ),
      ...createNudgeTools(this.deps, { userId: context.userId, threadId: context.threadId }, kit),
    ];
    const notes = await this.threads.systemNotes(context.userId, context.threadId);
    const graph = createAgent({
      model,
      tools,
      checkpointer: this.checkpointer,
      systemPrompt: SYSTEM_PROMPT,
      middleware: [
        historyTrimming(
          context.maxHistoryTokens,
          notes.map((note) => note.text),
        ),
        ...(fallback ? [modelFallbackMiddleware(fallback)] : []),
      ],
    });
    return {
      graph,
      kit,
      modelLabel: `${this.config.get('LLM_PROVIDER')}/${this.config.get('LLM_MODEL')}`,
    };
  }

  private async relay(
    stream: AsyncIterable<unknown>,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<{ usage: RunUsage }> {
    const byMessage = new Map<string, RunUsage>();
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error('RUN_ABORTED');
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const [mode, value] = chunk;
      if (mode === 'custom' && value && typeof value === 'object') {
        const event = value as AgentEvent;
        if (
          event.event === 'tool.status' ||
          event.event === 'card' ||
          event.event === 'draft.required'
        ) {
          emit(event);
        }
      } else if (mode === 'messages' && Array.isArray(value)) {
        const message = value[0] as
          | {
              id?: string;
              content?: unknown;
              getType?: () => string;
              _getType?: () => string;
              usage_metadata?: {
                input_tokens?: number;
                output_tokens?: number;
                output_token_details?: { reasoning?: number };
              } | null;
            }
          | undefined;
        if ((message?.getType?.() ?? message?._getType?.()) !== 'ai') continue;
        const meta = message?.usage_metadata;
        if (meta) {
          const key = typeof message.id === 'string' && message.id ? message.id : 'latest';
          byMessage.set(key, {
            inputTokens: meta.input_tokens,
            outputTokens: meta.output_tokens,
            thinkingTokens: meta.output_token_details?.reasoning ?? 0,
          });
        }
        const delta = messageDeltaText(message);
        if (delta) emit({ event: 'message.delta', data: { text: delta } });
      }
    }
    let inputTokens = 0,
      outputTokens = 0,
      thinkingTokens = 0;
    for (const usage of byMessage.values()) {
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
      thinkingTokens += usage.thinkingTokens ?? 0;
    }
    return { usage: { inputTokens, outputTokens, thinkingTokens } };
  }

  async cancel(userId: string, threadId: string): Promise<void> {
    await this.threads.owned(userId, threadId);
    const token = await this.redis.get(`agent:run:${threadId}`);
    if (token) await this.redis.set(`agent:cancel:${threadId}:${token}`, '1', 'EX', 120);
  }

  async action(input: {
    userId: string;
    threadId: string;
    cardId: string;
    action: string;
    payload: unknown;
    clientActionId?: string;
  }): Promise<unknown> {
    const lease = await this.acquire(input.threadId, new AbortController().signal);
    try {
      const maxQuantity = await this.appConfig.get('agent_max_qty_per_line');
      const outcome = await this.actions.perform({ ...input, maxQuantity });
      return outcome.result;
    } finally {
      await lease.release();
    }
  }

  private async acquire(
    threadId: string,
    original: AbortSignal,
  ): Promise<{ signal: AbortSignal; release: () => Promise<void> }> {
    const key = `agent:run:${threadId}`,
      token = randomUUID();
    if ((await this.redis.set(key, token, 'PX', 60000, 'NX')) !== 'OK')
      throw new Error('RUN_IN_PROGRESS');
    const cancellation = new AbortController();
    const signal = AbortSignal.any([original, cancellation.signal, AbortSignal.timeout(120000)]);
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void (async () => {
        const renewed = await this.redis.eval(RENEW, 1, key, token, '60000');
        const cancelled = await this.redis.get(`agent:cancel:${threadId}:${token}`);
        if (renewed !== 1 || cancelled) cancellation.abort();
      })()
        .catch(() => cancellation.abort())
        .finally(() => {
          renewing = false;
        });
    }, 5000);
    timer.unref();
    return {
      signal,
      release: async () => {
        clearInterval(timer);
        await this.redis.eval(RELEASE, 1, key, token).catch(() => undefined);
        await this.redis.del(`agent:cancel:${threadId}:${token}`).catch(() => undefined);
      },
    };
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
    emit: Emit,
  ): Promise<void> {
    const text = sanitizeAgentText(input.text);
    if (!text || text.length > 2000 || text !== input.text.trim()) throw new Error('INVALID_INPUT');
    const lease = await this.acquire(input.threadId, input.signal),
      signal = lease.signal;
    const started = Date.now();
    let runId: string | undefined,
      answer = '';
    const cards: AgentCard[] = [];
    try {
      const [
        dailyTurns,
        dailyTokens,
        maxCalls,
        maxSteps,
        maxQuantity,
        ttl,
        maxOrderPaise,
        maxHistoryTokens,
      ] = await Promise.all([
        this.appConfig.get('agent_daily_turn_limit_per_user'),
        this.appConfig.get('agent_daily_token_budget_per_user'),
        this.appConfig.get('agent_max_tool_calls_per_turn'),
        this.appConfig.get('agent_max_steps_per_run'),
        this.appConfig.get('agent_max_qty_per_line'),
        this.appConfig.get('agent_confirm_ttl_seconds'),
        this.appConfig.get('agent_max_order_value_paise'),
        this.appConfig.get('agent_history_max_tokens'),
      ]);
      const result = await this.runs.begin({
        ...input,
        text,
        dailyTurns,
        dailyTokens,
        outputReservation: this.config.get('LLM_MAX_OUTPUT_TOKENS'),
      });
      if (result.kind === 'replay') {
        emit({ event: 'run.started', data: { runId: input.clientMessageId } });
        if (result.text) emit({ event: 'message.delta', data: { text: result.text } });
        for (const existing of result.cards) emit({ event: 'card', data: existing });
        if (result.messageId)
          emit({ event: 'message.done', data: { messageId: result.messageId } });
        if (result.outcome !== 'completed')
          emit({
            event: 'run.error',
            data: { code: result.errorCode ?? 'RUN_FAILED', retryable: false },
          });
        emit({ event: 'run.ended', data: {} });
        return;
      }
      runId = result.runId;
      emit({ event: 'run.started', data: { runId } });
      const { graph, kit, modelLabel } = await this.createGraph({
        ...input,
        userText: text,
        maxCalls,
        maxQuantity,
        ttl,
        maxOrderPaise,
        maxHistoryTokens,
      });
      const stream = await graph.stream(
        { messages: [new HumanMessage({ content: text, id: input.clientMessageId })] },
        {
          configurable: { thread_id: input.threadId },
          streamMode: ['messages', 'custom'],
          recursionLimit: maxSteps,
          signal,
        },
      );
      const timed = await this.relay(stream as AsyncIterable<unknown>, signal, (event) => {
        if (event.event === 'card') cards.push(event.data);
        if (event.event === 'message.delta') {
          answer += event.data.text;
          if (answer.length > 16000) throw new Error('OUTPUT_LIMIT_REACHED');
        }
        emit(event);
      });
      const dbStarted = Date.now();
      const messageId = await this.runs.finish({
        runId,
        userId: input.userId,
        threadId: input.threadId,
        text: answer,
        cards,
        outcome: 'completed',
        latencyMs: Date.now() - started,
        usage: timed.usage,
        timings: { toolMs: kit.toolMs },
        model: `${modelLabel} ${PROMPT_VERSION}`,
        toolCalls: kit.used,
      });
      await this.runs.recordDbMs(runId, Date.now() - dbStarted).catch(() => {
        this.logger.warn('Could not record assistant completion transaction timing');
      });
      emit({ event: 'message.done', data: { messageId } });
      emit({ event: 'run.ended', data: {} });
    } catch (error: unknown) {
      if (!runId) throw error;
      const aborted = signal.aborted || (error instanceof Error && error.message === 'RUN_ABORTED');
      const code = agentFailureCode(error, aborted);
      this.logger.error(
        `${code}: model=${this.config.get('LLM_PROVIDER')}/${this.config.get('LLM_MODEL')} name=${error instanceof Error ? error.name : 'Error'}`,
      );
      await this.runs.finish({
        runId,
        userId: input.userId,
        threadId: input.threadId,
        text: answer,
        cards,
        outcome: aborted ? 'aborted' : 'failed',
        errorCode: code,
        latencyMs: Date.now() - started,
      });
      emit({ event: 'run.error', data: { code, retryable: !aborted } });
      emit({ event: 'run.ended', data: {} });
    } finally {
      await lease.release();
    }
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
    emit: Emit,
  ): Promise<void> {
    const lease = await this.acquire(input.threadId, input.signal),
      signal = lease.signal;
    const started = Date.now();
    let runId: string | undefined,
      answer = '';
    const cards: AgentCard[] = [];
    try {
      const [
        dailyTurns,
        dailyTokens,
        maxCalls,
        maxSteps,
        maxQuantity,
        ttl,
        maxOrderPaise,
        maxHistoryTokens,
      ] = await Promise.all([
        this.appConfig.get('agent_daily_turn_limit_per_user'),
        this.appConfig.get('agent_daily_token_budget_per_user'),
        this.appConfig.get('agent_max_tool_calls_per_turn'),
        this.appConfig.get('agent_max_steps_per_run'),
        this.appConfig.get('agent_max_qty_per_line'),
        this.appConfig.get('agent_confirm_ttl_seconds'),
        this.appConfig.get('agent_max_order_value_paise'),
        this.appConfig.get('agent_history_max_tokens'),
      ]);
      const result = await this.runs.beginResume({
        ...input,
        dailyTurns,
        dailyTokens,
        outputReservation: this.config.get('LLM_MAX_OUTPUT_TOKENS'),
      });
      if (result.kind === 'resolved') {
        emit({ event: 'run.started', data: { runId: input.draftId } });
        emit({
          event: 'message.delta',
          data: {
            text:
              result.status === 'executed'
                ? 'This action has already been completed.'
                : 'This confirmation is no longer active.',
          },
        });
        emit({ event: 'run.ended', data: {} });
        return;
      }
      runId = result.runId;
      emit({ event: 'run.started', data: { runId } });
      const { graph, kit, modelLabel } = await this.createGraph({
        ...input,
        maxCalls,
        maxQuantity,
        ttl,
        maxOrderPaise,
        maxHistoryTokens,
      });
      const stream = await graph.stream(
        new Command({ resume: { draftId: input.draftId, decision: input.decision } }),
        {
          configurable: { thread_id: input.threadId },
          streamMode: ['messages', 'custom'],
          recursionLimit: maxSteps,
          signal,
        },
      );
      const timed = await this.relay(stream as AsyncIterable<unknown>, signal, (event) => {
        if (isReplayedConfirmation(event, input.draftId)) return;
        if (event.event === 'card') cards.push(event.data);
        if (event.event === 'message.delta') {
          answer += event.data.text;
          if (answer.length > 16000) throw new Error('OUTPUT_LIMIT_REACHED');
        }
        emit(event);
      });
      const dbStarted = Date.now();
      const messageId = await this.runs.finish({
        runId,
        userId: input.userId,
        threadId: input.threadId,
        text: answer,
        cards,
        outcome: 'completed',
        latencyMs: Date.now() - started,
        usage: timed.usage,
        timings: { toolMs: kit.toolMs },
        model: `${modelLabel} ${PROMPT_VERSION}`,
        toolCalls: kit.used,
      });
      await this.runs.recordDbMs(runId, Date.now() - dbStarted).catch(() => {
        this.logger.warn('Could not record assistant completion transaction timing');
      });
      emit({ event: 'message.done', data: { messageId } });
      emit({ event: 'run.ended', data: {} });
    } catch (error: unknown) {
      if (!runId) throw error;
      const aborted = signal.aborted || (error instanceof Error && error.message === 'RUN_ABORTED');
      const code = agentFailureCode(error, aborted);
      this.logger.error(
        `${code}: model=${this.config.get('LLM_PROVIDER')}/${this.config.get('LLM_MODEL')} name=${error instanceof Error ? error.name : 'Error'}`,
      );
      await this.runs.finish({
        runId,
        userId: input.userId,
        threadId: input.threadId,
        text: answer,
        cards,
        outcome: aborted ? 'aborted' : 'failed',
        errorCode: code,
        latencyMs: Date.now() - started,
      });
      emit({ event: 'run.error', data: { code, retryable: !aborted } });
      emit({ event: 'run.ended', data: {} });
    } finally {
      await lease.release();
    }
  }
}
