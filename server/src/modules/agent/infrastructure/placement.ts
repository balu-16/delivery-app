import { z } from 'zod';
import { sql } from 'kysely';
import {
  IdempotencyStore,
  hashCanonical,
  hashRequest,
} from '../../../common/idempotency/idempotency.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  type Database,
  type Json,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type {
  CheckoutOperations,
  CheckoutPlacementGuard,
} from '../../checkout/contracts/checkout.js';
import { requireAgentPermission, assertAgentCommitAllowed } from './security.js';
import { draftHash } from './guards.js';

export const orderDraft = z
  .object({
    quoteId: z.string().uuid(),
    intentId: z.string().uuid(),
    addressId: z.string().uuid(),
    method: z.literal('COD'),
    totalPaise: z.string().regex(/^\d+$/),
    amountDuePaise: z.string().regex(/^\d+$/),
    formattedAddress: z.string(),
    items: z.array(
      z.object({
        variantId: z.string().uuid(),
        name: z.string(),
        variantName: z.string(),
        quantity: z.string(),
        unitPricePaise: z.string(),
      }),
    ),
    fees: z.array(
      z.object({
        kind: z.string(),
        amountPaise: z.string(),
        taxPaise: z.string(),
        taxSplit: z.string().nullable(),
      }),
    ),
    discountPaise: z.string(),
    taxTotalPaise: z.string(),
    walletCashPaise: z.string(),
    walletPromoPaise: z.string(),
    etaRange: z
      .object({
        minMinutes: z.number().int().nonnegative(),
        maxMinutes: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
  })
  .strict();

/** Uses the checkout saga's own idempotency operation and records approval in its transaction. */
export class AgentOrderPlacement {
  private readonly idempotency: IdempotencyStore;
  constructor(
    private readonly db: Database,
    private readonly checkout: CheckoutOperations,
  ) {
    this.idempotency = new IdempotencyStore(db);
  }

  async execute(input: {
    userId: string;
    threadId: string;
    draftId: string;
    payload: Json;
  }): Promise<Json> {
    const approved = orderDraft.parse(input.payload);
    const request = {
      quoteId: approved.quoteId,
      intentId: approved.intentId,
      method: approved.method,
    };
    const scope = {
      actor: input.userId,
      audience: 'customer',
      method: 'POST',
      resource: `/v1/customer/agent/drafts/${input.draftId}/order`,
      key: `agent:${input.draftId}`,
    };
    const claim = await this.idempotency.claim(
      scope,
      hashRequest(JSON.stringify(request)),
      120,
      hashCanonical(request),
    );
    if (claim.kind === 'replay') return claim.body;
    if (claim.kind === 'in_progress') throw new Error('RUN_IN_PROGRESS');
    if (claim.kind !== 'claimed') throw new Error('IDEMPOTENCY_KEY_REUSED');
    const expectedHash = draftHash(input.payload);
    const guard: CheckoutPlacementGuard = {
      beforePlace: async (tx: TransactionContext) => {
        await requireAgentPermission(input.userId, tx);
        await assertAgentCommitAllowed(tx, input.userId, input.threadId);
        const found = await sql<{
          status: string;
          payload: Json;
          payload_hash: string;
          expires_at: Date;
        }>`SELECT status,payload,payload_hash,expires_at FROM agent_drafts WHERE id=${input.draftId}::uuid AND user_id=${input.userId}::uuid AND thread_id=${input.threadId}::uuid AND type='order' FOR UPDATE`.execute(
          tx,
        );
        const draft = found.rows[0];
        if (!draft) throw new Error('RESOURCE_NOT_FOUND');
        const now = await databaseTimeAfterLock(tx);
        if (draft.status !== 'approved' || draft.expires_at.getTime() <= now.getTime())
          throw new Error('DRAFT_EXPIRED');
        if (draft.payload_hash !== expectedHash || draftHash(draft.payload) !== expectedHash)
          throw new Error('DRAFT_INVALID');
      },
      afterPlace: async (tx, result) => {
        if (!result.confirmed) throw new Error('PAYMENT_METHOD_UNAVAILABLE');
        const view = {
          orderId: result.order.orderId,
          orderNumber: result.order.orderNumber,
          status: result.order.status,
          paymentStatus: result.order.paymentStatus,
        };
        await sql`UPDATE agent_drafts SET status='executed',result=${JSON.stringify(view)}::jsonb,updated_at=clock_timestamp() WHERE id=${input.draftId}::uuid AND status='approved'`.execute(
          tx,
        );
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${input.userId}::uuid,'AGENT_ORDER_PLACED','order',${result.order.orderId},${JSON.stringify({ source: 'AGENT', threadId: input.threadId, draftId: input.draftId })}::jsonb)`.execute(
          tx,
        );
      },
    };
    try {
      return await this.idempotency.withRenewal(claim.owner, async () => {
        const result = await this.checkout.place(
          input.userId,
          { ...request, idempotencyOperationId: claim.owner.operationId },
          claim.owner,
          guard,
        );
        const body = {
          orderId: result.order.orderId,
          orderNumber: result.order.orderNumber,
          status: result.order.status,
          paymentStatus: result.order.paymentStatus,
        } as Json;
        await this.idempotency.execute(claim.owner, async () => ({ status: 200, body }));
        return body;
      });
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (
        [
          'PRICE_CHANGED',
          'QUOTE_EXPIRED',
          'CART_INTENT_CONSUMED',
          'CONCURRENT_MODIFICATION',
          'INVENTORY_INSUFFICIENT',
          'ADDRESS_NOT_SERVICEABLE',
          'DRAFT_EXPIRED',
        ].includes(code)
      )
        await sql`UPDATE agent_drafts SET status='stale',updated_at=clock_timestamp() WHERE id=${input.draftId}::uuid AND user_id=${input.userId}::uuid AND status='approved'`.execute(
          this.db,
        );
      throw error;
    }
  }
}
