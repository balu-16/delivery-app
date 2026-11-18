import type { AgentCard } from './types';

/** A saved written address may be confirmed elsewhere before the chat is reopened. */
export function pendingLocationAddressId(card: AgentCard): string | null {
  if (card.type !== 'info' || !Array.isArray(card.payload.options)) return null;
  for (const raw of card.payload.options) {
    if (!raw || typeof raw !== 'object') continue;
    const option = raw as {action?:unknown;payload?:{screen?:unknown;addressId?:unknown;needsLocation?:unknown}};
    if (option.action === 'open_screen' && option.payload?.screen === 'addresses' && option.payload.needsLocation === true && typeof option.payload.addressId === 'string') return option.payload.addressId;
  }
  return null;
}

/** Older conversations can contain identical address prompts from parallel searches. */
export function distinctAddressCards(cards: AgentCard[]): AgentCard[] {
  const seen = new Set<string>();
  return cards.filter(card => {
    const options = Array.isArray(card.payload.options) ? card.payload.options : [];
    if (card.type !== 'info' || options.length !== 1) return true;
    const option = options[0] as {action?: unknown; payload?: {screen?: unknown; addressId?: unknown}} | null;
    if (!option || option.action !== 'open_screen' || option.payload?.screen !== 'addresses') return true;
    const key = typeof option.payload.addressId === 'string' ? option.payload.addressId : 'new';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
