import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { canonicalProductKey, extractRequestedPhrases } from './product-resolver.js';
import type { CannedIntent } from './canned.js';

/**
 * Deterministic chat title from the first substantive request. Product names
 * come only from the verified catalog list, never from customer text, and no
 * addresses or phone numbers are ever copied.
 */
export function titleForRequest(
  intent: CannedIntent | 'model' | 'shopping',
  verifiedProductName: string | null,
): string {
  if (intent === 'greeting') return 'New chat';
  if (intent === 'faq_tracking') return 'Track an order';
  if (verifiedProductName) return `${verifiedProductName} for your cart`;
  if (intent === 'shopping' || intent === 'model') return 'Shopping help';
  return 'Shopping help';
}

/** Longest verified catalog product phrase in the message, or null. */
export function verifiedProductInText(
  message: string,
  catalogNames: ReadonlyArray<{ key: string; display: string }>,
): string | null {
  const requested = extractRequestedPhrases(
    message,
    catalogNames.map((item) => item.key),
  );
  for (const item of requested) {
    const canonical = canonicalProductKey(item.key);
    const found = catalogNames.find(
      (entry) =>
        canonicalProductKey(entry.key) === canonical ||
        canonicalProductKey(entry.display) === canonical,
    );
    if (found) return found.display;
  }
  return null;
}

export async function setThreadTitleIfUnset(
  db: Database | TransactionContext,
  userId: string,
  threadId: string,
  title: string,
): Promise<void> {
  await sql`UPDATE agent_threads SET title=${title}
    WHERE id=${threadId}::uuid AND user_id=${userId}::uuid AND title IS NULL`.execute(db);
}
