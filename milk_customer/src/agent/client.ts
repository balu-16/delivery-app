import { fetch } from 'expo/fetch';
import { apiBaseUrl, ApiError, customerRequest } from '../api/client';
import { accessToken } from '../auth/session';
import { SseParser } from './sse';
import { loadAgentAvailability } from './availability';
import type { AgentConfig, AgentEvent, AgentLocale, AgentMessage, AgentRun, AgentThread, AgentThreadSummary } from './types';

const root = '/v1/customer/agent';
const path = (threadId: string) => `${root}/threads/${encodeURIComponent(threadId)}`;
async function request<T>(suffix: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  return customerRequest<T>(`${root}${suffix}`, { token: await accessToken(), method, ...(body === undefined ? {} : { body }) });
}
export const agentClient = {
  config: (locale?: AgentLocale) => loadAgentAvailability(() => request<AgentConfig>(`/config${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`)),
  current: () => request<AgentThread>('/threads/current'),
  threads: (cursor?: string) => request<{ items: AgentThreadSummary[]; nextCursor: string | null }>(`/threads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  thread: (id: string) => request<AgentThread>(`/threads/${encodeURIComponent(id)}`),
  create: () => request<AgentThread>('/threads', 'POST', {}),
  history: (id: string, cursor: string) => request<{ items: AgentMessage[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(id)}/messages?cursor=${encodeURIComponent(cursor)}`),
  cancel: (id: string) => request<void>(`/threads/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  action: (id: string, cardId: string, action: string, payload: Record<string, unknown>, clientActionId: string) => request<unknown>(`/threads/${encodeURIComponent(id)}/actions`, 'POST', { cardId, action, payload, clientActionId }),
  feedback: (messageId: string, rating: 'up' | 'down') => request<void>(`/messages/${encodeURIComponent(messageId)}/feedback`, 'POST', { rating }),
  consent: async (version: string) => customerRequest<void>('/v1/customer/me/consents', { token: await accessToken(), method: 'POST', body: { type: 'ai_assistant', version } }),
  consentStatus: async () => customerRequest<{ accepted: boolean; version: string }>('/v1/customer/me/consents/ai-assistant', { token: await accessToken() }),
  revokeConsent: async () => customerRequest<void>('/v1/customer/me/consents/ai-assistant', { token: await accessToken(), method: 'DELETE' }),
  message: (threadId: string, clientMessageId: string, text: string, locale: AgentLocale, signal: AbortSignal, onEvent: (event: AgentEvent) => void) =>
    stream(`${path(threadId)}/messages`, { clientMessageId, text, locale }, signal, onEvent),
  resume: (threadId: string, draftId: string, decision: 'approve' | 'reject', locale: AgentLocale, signal: AbortSignal, onEvent: (event: AgentEvent) => void, clientActionId: string) =>
    stream(`${path(threadId)}/resume`, { draftId, decision, locale, clientActionId }, signal, onEvent),
  currentRun: (threadId: string) => request<AgentRun | null>(`/threads/${encodeURIComponent(threadId)}/runs/current`),
  followRun: (threadId: string, runId: string, signal: AbortSignal, onEvent: (event: AgentEvent) => void, after?: string) =>
    stream(`${path(threadId)}/runs/${encodeURIComponent(runId)}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`, undefined, signal, onEvent),
};

async function stream(endpoint: string, body: object | undefined, signal: AbortSignal, onEvent: (event: AgentEvent) => void): Promise<void> {
  const token = await accessToken();
  const response = await fetch(`${apiBaseUrl()}${endpoint}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: 'text/event-stream, application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal,
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { code?: unknown; traceId?: unknown } | null;
    throw new ApiError(response.status, typeof problem?.code === 'string' ? problem.code : 'REQUEST_FAILED', typeof problem?.traceId === 'string' ? problem.traceId : undefined);
  }
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    const result = await response.json() as { events?: AgentEvent[] };
    for (const event of result.events ?? []) onEvent(event);
    return;
  }
  if (!response.body) {
    const fallback = await fetch(`${apiBaseUrl()}${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal,
    });
    if (!fallback.ok) throw new Error('STREAM_UNAVAILABLE');
    const result = await fallback.json() as { events?: AgentEvent[] };
    for (const event of result.events ?? []) onEvent(event);
    return;
  }
  const reader = response.body.getReader();
  let ended = false;
  const observe = (event: AgentEvent) => { if (event.event === 'run.ended') ended = true; onEvent(event); };
  const watching = new SseParser(observe);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      watching.push(chunk.value);
    }
    watching.finish();
    if (!ended) throw new Error('STREAM_INCOMPLETE');
  } finally { reader.releaseLock(); }
}
