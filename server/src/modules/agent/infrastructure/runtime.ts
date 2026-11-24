import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { createAgent, modelFallbackMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { isReplayedConfirmation } from './confirmation-events.js';
import {
  cannedReply,
  matchCannedIntent,
  priorUserMessageCount,
  rotatingReplyKey,
  trackingStatusLine,
  type CannedIntent,
} from './canned.js';
import {
  choiceNeedsRefresh,
  choiceOptions,
  choiceReply,
  commitChoice,
  insertChoice,
  parseChoiceAnswer,
  pendingChoice,
  refreshChoice,
  saveChoiceAnswer,
  type ChoiceRef,
  type ChoiceRow,
} from './choices.js';
import { addRequestText } from './choice-answer.js';
import { canonicalProductKey } from './product-resolver.js';
import { setThreadTitleIfUnset, titleForRequest, verifiedProductInText } from './titles.js';
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
import type {
  AgentCard,
  AgentChoiceReference,
  AgentEvent,
  AgentLocale,
} from '../contracts/agent.js';
import type { CustomerTracking } from '../../dispatch/contracts/tasks.js';
import type { Serviceability } from '../../serviceability/contracts/serviceability.js';
import type { CouponValidation } from '../../coupons/contracts/coupons.js';
import { createAssistantModel } from './llm/llm.factory.js';
import { createReadTools } from './read-tools.js';
import { AgentToolKit } from './tool-kit.js';
import { AgentCandidateStore } from './product-candidates.js';
import { createWriteTools } from './write-tools.js';
import { createConfirmTools } from './confirm-tools.js';
import { createChoiceTools } from './choice-tools.js';
import { AgentDrafts } from './drafts.js';
import { AgentOrderPlacement } from './placement.js';
import { AgentActions } from './actions.js';
import { messageDeltaText, sanitizeAgentText } from './guards.js';
import { historyTrimming } from './middleware.js';
import { createNudgeTools } from './nudge-tools.js';
import { SYSTEM_PROMPT, PROMPT_VERSION } from './prompts/system.base.v2.js';
import type { AgentNudges } from './nudges.js';
import type { AgentRuns, LocalInput, LocalReply } from './runs.js';
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
    this.actions = new AgentActions(deps, threads, appConfig);
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
    const candidates = new AgentCandidateStore();
    // The model gets the choice tool only when the turn may need it: an
    // active choice is waiting, or the message carries shopping intent.
    const choicePending =
      (await pendingChoice(this.deps.db, context.userId, context.threadId)) !== null;
    const shoppingHint = /\b(add|buy|cart|pack|packs|size|quantity)\b/.test(context.userText ?? '');
    const choiceTools =
      choicePending || shoppingHint
        ? createChoiceTools(
            this.deps,
            { userId: context.userId, threadId: context.threadId, confirmTtlSeconds: context.ttl },
            kit,
          )
        : [];
    const tools = [
      ...createReadTools(
        { ...this.deps, appConfig: this.appConfig },
        {
          userId: context.userId,
          locale: context.locale,
          userText: context.userText,
          clientMessageId: context.clientMessageId,
          candidates,
        },
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
          candidates,
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
      ...choiceTools,
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

  /**
   * Answer without the model when possible: canned greetings, thanks, FAQs
   * and typed cart-choice answers. Same retry keys and history as model
   * turns, zero model usage. Returns true when the turn was fully handled.
   */
  async tryLocalReply(
    input: LocalInput & { choice?: AgentChoiceReference },
    emit: Emit,
  ): Promise<boolean> {
    const text = sanitizeAgentText(input.text);
    if (!text || text.length > 2000 || text !== input.text.trim()) throw new Error('INVALID_INPUT');
    const message = { ...input, text };
    const replay = await this.runs.replayLocal(message);
    if (replay) {
      this.emitLocal(replay, emit);
      return true;
    }
    const intent = matchCannedIntent(text);
    if (intent !== 'model') return this.localCannedTurn(message, intent, emit);
    const choice = await pendingChoice(this.deps.db, input.userId, input.threadId, input.choice);
    const parsed = choice && parseChoiceAnswer(text, choice.variants);
    if (!choice || !parsed) return this.localCartRequest(message, emit);
    const ref = {
      userId: input.userId,
      threadId: input.threadId,
      choiceId: choice.id,
      choiceVersion: input.choice?.choiceVersion ?? choice.version,
    };
    await this.localChoiceTurn(
      message,
      ref,
      choice,
      {
        variantId: parsed.variantId ?? choice.selection?.variantId ?? null,
        quantity: parsed.quantity ?? choice.selection?.quantity ?? null,
      },
      emit,
    );
    return true;
  }

  private async localCartRequest(input: LocalInput, emit: Emit): Promise<boolean> {
    const query = addRequestText(input.text);
    if (!query || query.length > 100) return false;
    const { offer } = await choiceOptions(this.deps, { userId: input.userId, query });
    if (!offer || canonicalProductKey(offer.product) !== canonicalProductKey(query)) return false;
    const ttlSeconds = await this.appConfig.get('agent_confirm_ttl_seconds');
    const saved = await this.runs.completeLocal(input, async (tx) => {
      const choice = await insertChoice(
        tx,
        { ...input, ttlSeconds },
        offer.variants,
        offer.delivery,
        offer.question,
      );
      await setThreadTitleIfUnset(
        tx,
        input.userId,
        input.threadId,
        titleForRequest('shopping', offer.product),
      );
      return choiceReply(choice);
    });
    this.emitLocal(saved, emit);
    return true;
  }

  private emitLocal(reply: LocalReply & { runId: string; messageId: string }, emit: Emit): void {
    emit({ event: 'run.started', data: { runId: reply.runId } });
    if (reply.text) emit({ event: 'message.delta', data: { text: reply.text } });
    for (const card of reply.cards) emit({ event: 'card', data: card });
    emit({ event: 'message.done', data: { messageId: reply.messageId } });
    emit({ event: 'run.ended', data: {} });
  }

  private async localCannedTurn(
    input: LocalInput,
    intent: CannedIntent,
    emit: Emit,
  ): Promise<boolean> {
    const count = await priorUserMessageCount(this.deps.db, input.userId, input.threadId);
    const key =
      intent === 'greeting' || intent === 'thanks' ? rotatingReplyKey(intent, count) : intent;
    const reply = await cannedReply(this.deps.db, key);
    let bodyText = reply.body;
    if (intent === 'faq_tracking') {
      const page = await this.deps.orders.list(input.userId, 1);
      const latest = page.items[0];
      bodyText = `${trackingStatusLine(latest ? { orderNumber: latest.orderNumber, status: latest.status } : null)} ${reply.body}`;
    }
    const links = {
      cart: 'Open cart',
      addresses: 'Delivery addresses',
      orders: 'View orders',
      support: 'Get support',
    };
    const label =
      reply.link && Object.hasOwn(links, reply.link) && links[reply.link as keyof typeof links];
    const cards: AgentCard[] = label
      ? [
          {
            cardId: randomUUID(),
            type: 'info',
            payload: {
              options: [{ label, action: 'open_screen', payload: { screen: reply.link } }],
            },
          },
        ]
      : [];
    const saved = await this.runs.completeLocal(input, async (tx) => {
      if (intent !== 'greeting' && intent !== 'thanks')
        await setThreadTitleIfUnset(
          tx,
          input.userId,
          input.threadId,
          titleForRequest(intent, null),
        );
      return { text: bodyText, cards };
    });
    this.emitLocal(saved, emit);
    return true;
  }

  private async localChoiceTurn(
    input: LocalInput,
    ref: ChoiceRef,
    choice: ChoiceRow,
    answer: { variantId: string | null; quantity: number | null },
    emit: Emit,
  ): Promise<void> {
    const [maxQuantity, ttl] = await Promise.all([
      this.appConfig.get('agent_max_qty_per_line'),
      this.appConfig.get('agent_confirm_ttl_seconds'),
    ]);
    try {
      const saved = await this.runs.completeLocal(input, async (tx) => {
        const { variantId, quantity } = answer;
        if (variantId === null || quantity === null)
          return choiceReply(await saveChoiceAnswer(tx, ref, answer, maxQuantity));
        const { result, replayed } = await commitChoice(this.deps, tx, {
          ...ref,
          variantId,
          quantity,
          maxQuantity,
          answeredInMessage: true,
        });
        const line = (result as { items?: { variantId: string; name: string }[] })?.items?.find(
          (item) => item.variantId === variantId,
        );
        return {
          text: replayed
            ? 'That choice was already saved to your cart.'
            : line?.name
              ? `Added ${quantity} × ${line.name} to your cart.`
              : 'Added that to your cart.',
          cards: [],
        };
      });
      this.emitLocal(saved, emit);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (choiceNeedsRefresh(code)) {
        try {
          const saved = await refreshChoice(this.deps, { ...ref, ttlSeconds: ttl }, (tx, fresh) =>
            this.runs.completeLocal(
              input,
              async () => choiceReply(fresh, 'Please review the current options. '),
              tx,
            ),
          );
          this.emitLocal(saved, emit);
          return;
        } catch (failure) {
          // Another request may already have replaced this exact prompt.
          if (
            !(failure instanceof Error) ||
            !['DRAFT_NOT_PENDING', 'CONCURRENT_MODIFICATION'].includes(failure.message)
          )
            throw failure;
        }
      } else if (
        !['INVALID_QUANTITY', 'DRAFT_NOT_PENDING', 'CONCURRENT_MODIFICATION'].includes(code)
      ) {
        throw error;
      }
      const body: LocalReply =
        code === 'INVALID_QUANTITY'
          ? choiceReply(choice, `Check the quantity (up to ${maxQuantity} packs per item). `)
          : {
              text: 'That choice has changed. Use the latest options or ask for the item again.',
              cards: [],
            };
      this.emitLocal(await this.runs.completeLocal(input, async () => body), emit);
    }
  }

  /** Deterministic title from the first substantive request; greeting opens as New chat. */
  private async ensureThreadTitle(userId: string, threadId: string, text: string): Promise<void> {
    if ((await this.threads.title(userId, threadId)) !== null) return;
    const preview = await this.deps.catalog.preview();
    const names = [
      ...new Map(preview.items.map((item) => [item.productId, item.name])).values(),
    ].map((name) => ({ key: name, display: name }));
    await setThreadTitleIfUnset(
      this.deps.db,
      userId,
      threadId,
      titleForRequest('model', verifiedProductInText(text, names)),
    );
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
      await this.ensureThreadTitle(input.userId, input.threadId, text);
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
