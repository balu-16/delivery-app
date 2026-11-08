import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';

/** Called while holding the attempt lock; replaying a capture adds no funding. */
export async function recordCapture(
  tx: TransactionContext,
  input: {
    attemptId: string;
    orderId: string | null;
    paymentId: string;
    amountPaise: string;
    currency: string;
  },
): Promise<string | null> {
  const inserted = await sql<{ id: string }>`INSERT INTO payment_capture_receipts
    (id,attempt_id,order_id,gateway_payment_id,amount_paise,currency)
    VALUES(${uuidV7()}::uuid,${input.attemptId}::uuid,${input.orderId}::uuid,${input.paymentId},${input.amountPaise}::bigint,${input.currency})
    ON CONFLICT(gateway_payment_id) DO NOTHING RETURNING id`.execute(tx);
  if (inserted.rows[0]) return inserted.rows[0].id;
  const old = await sql<{
    attempt_id: string;
    amount_paise: string;
    currency: string;
  }>`SELECT attempt_id,amount_paise::text,currency
    FROM payment_capture_receipts WHERE gateway_payment_id=${input.paymentId}`.execute(tx);
  if (
    old.rows[0]?.attempt_id !== input.attemptId ||
    old.rows[0].amount_paise !== input.amountPaise ||
    old.rows[0].currency !== input.currency
  )
    throw new Error('CAPTURE_CORRELATION_MISMATCH');
  return null;
}
