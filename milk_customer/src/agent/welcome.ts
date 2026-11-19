/** Four branded welcomes, rotated per chat and kept outside the server transcript. */
export const WELCOMES = [
  'Hi, I’m your DairyDirect assistant. How can I help?',
  'Hello! I can help with your cart and orders.',
  'Welcome! What would you like to shop for today?',
  'Hey! I can help you find products or track a delivery.',
] as const;

export function welcomeFor(threadId?: string): string {
  if (!threadId) return WELCOMES[0];
  let hash = 0;
  for (const char of threadId) hash += char.codePointAt(0) ?? 0;
  return WELCOMES[hash % WELCOMES.length];
}
