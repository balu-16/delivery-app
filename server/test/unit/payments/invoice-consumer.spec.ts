import { InvoicingEventConsumer } from '../../../src/modules/invoicing/infrastructure/invoice-consumer.js';
import type { InvoicingOperations } from '../../../src/modules/invoicing/contracts/invoicing.js';
import type { TransactionContext } from '../../../src/platform/database/database.js';
import type { EventEnvelope } from '../../../src/platform/outbox/outbox.js';

it('passes fulfillment shorts to the issuer to decide whether a credit note is due', async () => {
  const calls: unknown[] = [];
  const invoicing = {
    recordCreditNote: async (input: unknown) => {
      calls.push(input);
      return null;
    },
  } as unknown as InvoicingOperations;
  const consumer = new InvoicingEventConsumer(invoicing);
  const tx = {} as TransactionContext;
  const event = {
    eventType: 'payments.refund.settled',
    payload: {
      orderId: 'order',
      refundId: 'refund',
      amountPaise: '100',
      reason: 'FULFILLMENT_SHORT',
    },
  } as unknown as EventEnvelope;
  await consumer.handle(tx, event);
  expect(calls).toEqual([
    {
      orderId: 'order',
      refundId: 'refund',
      amountPaise: '100',
      reason: 'FULFILLMENT_SHORT',
      reference: 'refund:refund',
      tx,
    },
  ]);
});
