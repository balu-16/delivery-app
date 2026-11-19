import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';

/** Intents answerable on the server with zero model use. Anything else routes to the model. */
export type CannedIntent =
  'greeting' | 'thanks' | 'faq_cart' | 'faq_address' | 'faq_tracking' | 'faq_support' | 'help';

export function normalizeIntentText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const GREETING_ONLY =
  /^(hi+|hii+|hello+|hey+|yo|namaste|vanakkam|good morning|good afternoon|good evening|good day)[!., ]*$/;
const THANKS =
  /^(?:thanks|thank you|thankyou|thx|dhanyavadalu|dhanyavaad|shukriya)(?: so much| very much| a lot| for your help)?$/;
/** Action verbs that always route to the model, even after a greeting. */
const SHOPPING =
  /\b(add|buy|get|order|ordering|purchase|need|want)\b.*\b(cart|pack|packs|kg|gram|g\b|litre|liter|ml|dozen|bottle|packet|curd|milk|butter|paneer|ghee|cheese)\b|\badd\b|\border them\b|\bcheckout\b|\bplace\b.*\border\b/;
const ORDER_ACTION = /\b(cancel|refund|return|replace)\b/;
const SUPPORT_ACTION =
  /\b(ticket|complaint|raise|report).*\b(order|delivery|payment|item)\b|\b(raise|file).*\bticket\b/;

/**
 * Match the whole intent. Shopping and order/support actions always win so
 * "Hi, add curd to my cart" goes to shopping instead of the greeting reply.
 * Returns null when the model must handle the message.
 */
export function matchCannedIntent(text: string): CannedIntent | 'model' {
  const normalized = normalizeIntentText(text);
  if (!normalized) return 'model';
  if (
    SHOPPING.test(normalized) ||
    ORDER_ACTION.test(normalized) ||
    /\b(remove|clear|empty|increase|decrease)\b.*\b(cart|basket)\b/.test(normalized) ||
    SUPPORT_ACTION.test(normalized) ||
    /\bsave\b.*\baddress\b/.test(normalized) ||
    /\b(change|update|set)\b.*\baddress\b/.test(normalized)
  )
    return 'model';
  if (GREETING_ONLY.test(normalized)) return 'greeting';
  if (THANKS.test(normalized)) return 'thanks';
  if (/\b(cart|basket|checkout total|bill)\b/.test(normalized)) return 'faq_cart';
  if (
    /\b(address|addresses|pincode|pin code|gps|location|deliver to|delivery address)\b/.test(
      normalized,
    )
  )
    return 'faq_address';
  if (
    /\b(track|tracking|order status|delivery status|arriving|reached)\b/.test(normalized) ||
    /\bwhere\b.*\b(order|delivery|package|parcel)\b/.test(normalized)
  )
    return 'faq_tracking';
  if (/\b(support|helpdesk|human|call|contact|help me|need help)\b/.test(normalized))
    return 'faq_support';
  if (
    /^(help|hi help|hello help|what can you do|how does this work|options|menu)$/.test(normalized)
  )
    return 'help';
  return 'model';
}

/** Deterministic rotation over the four greeting/thanks variants. */
export function rotatingReplyKey(intent: 'greeting' | 'thanks', priorUserMessages: number): string {
  const slot = (Math.max(0, priorUserMessages) % 4) + 1;
  return `${intent === 'greeting' ? 'greeting' : 'thanks'}_${slot}`;
}

export interface CannedReply {
  key: string;
  version: number;
  title: string;
  body: string;
  link: string | null;
}

export async function cannedReply(db: Database, key: string): Promise<CannedReply> {
  const found =
    await sql<CannedReply>`SELECT key,version,title,body,link FROM agent_canned_replies WHERE key=${key}`.execute(
      db,
    );
  const row = found.rows[0];
  if (!row) throw new Error('RESOURCE_NOT_FOUND');
  return row;
}

export async function priorUserMessageCount(
  db: Database,
  userId: string,
  threadId: string,
): Promise<number> {
  const found = await sql<{ n: string }>`SELECT count(*)::text AS n FROM agent_messages
    WHERE thread_id=${threadId}::uuid AND role='user'
    AND id IN (SELECT m.id FROM agent_messages m JOIN agent_threads t ON t.id=m.thread_id WHERE t.user_id=${userId}::uuid AND t.id=${threadId}::uuid)`.execute(
    db,
  );
  return Number(found.rows[0]?.n ?? 0);
}

const ORDER_STATUS_WORDS: Record<string, string> = {
  CONFIRMED: 'confirmed',
  PREPARING: 'being prepared',
  READY: 'packed and ready',
  ASSIGNED: 'assigned to a rider',
  PICKED_UP: 'picked up',
  OUT_FOR_DELIVERY: 'out for delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  FAILED: 'could not be completed',
};

/** Personal tracking line from the signed-in customer's own order data. */
export function trackingStatusLine(order: { orderNumber: string; status: string } | null): string {
  if (!order) return 'You have no orders yet.';
  const word = ORDER_STATUS_WORDS[order.status] ?? 'in progress';
  return `Your latest order ${order.orderNumber} is ${word}.`;
}
