import { createHash } from 'node:crypto';

/** Free text is data, never markup or a set of instructions for a tool. */
export function sanitizeAgentText(value: string, maxLength = 2000): string {
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 ? '' : character;
  }).join('');
  return printable
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, maxLength);
}
export function assertQuantity(value: number, maximum: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum)
    throw new Error('INVALID_QUANTITY');
}
/** Stable JSON for an approval payload; payloads contain plain JSON only. */
export function draftHash(payload: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}
export function assertPendingDraft(
  status: string,
  expiresAt: Date,
  hash: string,
  payload: unknown,
  now = new Date(),
): void {
  if (status !== 'pending') throw new Error('DRAFT_NOT_PENDING');
  if (expiresAt.getTime() <= now.getTime()) throw new Error('DRAFT_EXPIRED');
  if (draftHash(payload) !== hash) throw new Error('DRAFT_INVALID');
}
/** Visible text of a streamed AI message chunk. Thinking/reasoning blocks (including Google
 * Gemma parts flagged `thought: true`), tool calls and provider metadata are never
 * customer-visible text. */
export function messageDeltaText(message: unknown): string {
  const raw = (message as { content?: unknown } | undefined)?.content;
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as { type?: unknown; text?: unknown; thought?: unknown };
      return block.type === 'text' && block.thought !== true && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .join('');
}
