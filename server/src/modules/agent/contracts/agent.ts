export type AgentLocale = 'en' | 'hi' | 'te';
export interface AgentChoiceReference {
  choiceId: string;
  choiceVersion: number;
}
export type AgentCardType =
  | 'product_list'
  | 'address_confirm'
  | 'order_confirm'
  | 'order_status'
  | 'out_of_stock'
  | 'delivery_unavailable'
  | 'payment_unavailable'
  | 'cart_attention'
  | 'cancel_confirm'
  | 'refund_confirm'
  | 'cart_choice'
  // Legacy recurring card: kept so stored chats decode and render read-only.
  | 'subscription_confirm'
  | 'quick_replies'
  | 'info';
export interface AgentCard {
  cardId: string;
  type: AgentCardType;
  payload: Record<string, unknown>;
}
export type AgentEvent =
  | { event: 'run.started'; data: { runId: string } }
  | { event: 'message.delta'; data: { text: string } }
  | { event: 'tool.status'; data: { labelKey: string; phase: 'start' | 'end' } }
  | { event: 'card'; data: AgentCard }
  | { event: 'draft.required'; data: { draftId: string; type: string; expiresAt: string } }
  | { event: 'message.done'; data: { messageId: string } }
  | { event: 'run.error'; data: { code: string; retryable: boolean } }
  | { event: 'run.ended'; data: Record<string, never> };
export interface ToolContext {
  userId: string;
  threadId: string;
  runId: string;
  locale: AgentLocale;
  requestId: string;
}
export const AGENT_DISCLOSURE_VERSION = '1';
export interface AgentConfigView {
  enabled: boolean;
  suggestedPrompts: string[];
  maxMessageChars: number;
  disclosureVersion: string;
  supportedLocales: AgentLocale[];
}
export const AGENT_OPERATIONS = Symbol('AGENT_OPERATIONS');
export interface AgentRunView {
  id: string;
  threadId: string;
  state: 'queued' | 'running' | 'completed' | 'waiting' | 'failed' | 'cancelled';
  errorCode: string | null;
  clientMessageId: string | null;
}
export interface AgentOperations {
  config(locale?: AgentLocale): Promise<AgentConfigView>;
  current(userId: string, locale?: AgentLocale): Promise<unknown>;
  listThreads(userId: string, cursor?: string): Promise<unknown>;
  thread(userId: string, threadId: string): Promise<unknown>;
  create(userId: string, locale?: AgentLocale): Promise<unknown>;
  messages(userId: string, threadId: string, cursor?: string): Promise<unknown>;
  feedback(
    userId: string,
    messageId: string,
    rating: 'up' | 'down',
    reason?: string,
  ): Promise<void>;
  assertAllowed(userId: string, threadId?: string): Promise<void>;
  run(
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
  ): Promise<void>;
  resume(
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
  ): Promise<void>;
  cancel(userId: string, threadId: string): Promise<void>;
  currentRun(userId: string, threadId: string): Promise<AgentRunView | null>;
  followRun(
    userId: string,
    threadId: string,
    runId: string,
    after: string | undefined,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void>;
  deleteThread(userId: string, threadId: string): Promise<void>;
  deleteAllThreads(userId: string): Promise<void>;
  action(
    userId: string,
    threadId: string,
    cardId: string,
    action: string,
    payload: unknown,
    clientActionId?: string,
  ): Promise<unknown>;
}
