import type { AgentMessage } from './types';

export type AddressContinuation = { id: string; sourceId: string; addressId: string | null; waitingForLocation: boolean; selected: boolean };
export const addressContinuationKey = (userId:string, threadId:string) => `@dairydirect/address-continuation:${userId}:${threadId}`;
export function lastShoppingRequest(messages: AgentMessage[]): AgentMessage | undefined {
  return [...messages].reverse().find(message => {
    if (message.role !== 'user') return false;
    const text = message.text;
    const addressDetails = /\b(?:address|location)\b/i.test(text) && /\b(?:pin\s*code|pincode|phone|mobile)\b/i.test(text);
    const addressOnly = /\b(?:add|save|create|update|change|set|use|confirm)\s+(?:(?:the|my|an?|delivery|new|current)\s+){0,3}(?:address|location)\b/i.test(text) && !/\b(?:cart|milk|curd|butter|paneer|ghee|lassi|yogurt)\b/i.test(text);
    return !addressDetails && !addressOnly && /\b(?:add|order|buy|reorder|get|send|deliver|want|need)\b/i.test(text);
  });
}
export function continuationText(intent: string): string {
  return `My delivery address is saved and selected. Please use my default address and continue my earlier request: ${intent.trim()}`;
}
export function readAddressContinuation(raw: string): AddressContinuation | null {
  try {
    const value = JSON.parse(raw) as AddressContinuation;
    if (typeof value.id === 'string' && typeof value.sourceId === 'string' && (value.addressId === null || typeof value.addressId === 'string') && typeof value.waitingForLocation === 'boolean' && typeof value.selected === 'boolean') return value;
  } catch { /* Invalid records are never sent. */ }
  return null;
}
