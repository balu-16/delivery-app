import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { type EventEnvelope } from '../../../src/platform/outbox/outbox.js';
import { consumeOnce } from '../../../src/platform/events/consume.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import { RATINGS, type Ratings } from '../../../src/modules/ratings/contracts/ratings.js';
import { SUPPORT, type Support } from '../../../src/modules/support/contracts/support.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import {
  ORDERS,
  ORDER_CODES,
  type OrderOperations,
  type OrderCodes,
} from '../../../src/modules/orders/contracts/orders.js';
import { OrderPaymentEventConsumer } from '../../../src/modules/orders/infrastructure/order-consumer.js';
import { PAYMENT_GATEWAY } from '../../../src/modules/payments/contracts/gateway.js';
import {
  PAYMENT_WEBHOOKS,
  PAYMENT_REFUNDS,
  type PaymentWebhookIngest,
  type PaymentRefundOperations,
} from '../../../src/modules/payments/contracts/payments.js';
import { FakeGateway } from '../../../src/adapters/payments/fake-gateway.js';
import { OrderConfirmedConsumer as PickConsumer } from '../../../src/modules/picking/infrastructure/confirmation-consumer.js';
import { OrderConfirmedConsumer as DispatchConsumer } from '../../../src/modules/dispatch/infrastructure/consumers.js';
import { PICK_TASKS, type PickTasks } from '../../../src/modules/picking/contracts/tasks.js';
import {
  HANDOVER_CODES,
  PICK_PACKING,
  type HandoverCodes,
  type PickPacking,
} from '../../../src/modules/picking/contracts/packing.js';
import {
  DELIVERY_CODES,
  DELIVERY_TASKS,
  type DeliveryCodes,
  type DeliveryTasks,
} from '../../../src/modules/dispatch/contracts/tasks.js';
import {
  APP_CONFIG,
  ADMIN_CONFIG,
  type AppConfig,
  type AdminConfig,
} from '../../../src/modules/app-config/contracts/config.js';
import {
  INVOICING,
  type InvoicingOperations,
} from '../../../src/modules/invoicing/contracts/invoicing.js';
import { InvoicingEventConsumer } from '../../../src/modules/invoicing/infrastructure/invoice-consumer.js';
import {
  NOTIFICATION_PIPELINE,
  type NotificationPipeline,
} from '../../../src/modules/notifications/contracts/notifications.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
import {
  CHECKOUT_PAYMENTS,
  type CustomerPayments,
} from '../../../src/modules/checkout/contracts/customer-payments.js';
import {
  DELIVERY_ASSIGNMENT,
  type DeliveryAssignment,
} from '../../../src/modules/dispatch/contracts/tasks.js';
import {
  RIDER_OPERATIONS,
  RIDER_EARNINGS,
  type RiderOperations,
  type RiderEarnings,
} from '../../../src/modules/riders/contracts/riders.js';
import { recoverDisconnected } from '../../../src/modules/picking/infrastructure/presence.js';
import { InventoryExpiry } from '../../../src/modules/inventory/infrastructure/expiry.js';
import {
  INVENTORY_RETURNS,
  type InventoryReturns,
} from '../../../src/modules/inventory/contracts/returns.js';
import { InventoryShortfallConsumer } from '../../../src/modules/picking/infrastructure/inventory-shortfall-consumer.js';
import {
  ORDER_CANCELLATION,
  type OrderCancellation,
} from '../../../src/modules/picking/contracts/fulfillment.js';
import {
  PICK_CANCELLATION,
  type PickCancellation,
} from '../../../src/modules/picking/contracts/tasks.js';
import {
  DELIVERY_RETURN,
  DELIVERY_POD,
  DELIVERY_TASK_CANCELLATION,
  type DeliveryReturn,
  type DeliveryPod,
  type DeliveryTaskCancellation,
} from '../../../src/modules/dispatch/contracts/tasks.js';
import { PRIVATE_UPLOADS } from '../../../src/modules/identity/contracts/uploads.js';
import type { LocalPrivateUploads } from '../../../src/adapters/storage/local-private.js';
import {
  ORDER_ADMINISTRATION,
  type OrderAdministration,
} from '../../../src/modules/orders/contracts/administration.js';
import {
  WALLET_SPENDER,
  WALLET_VIEWS,
  type WalletSpender,
  type WalletViews,
} from '../../../src/modules/wallet/contracts/wallet.js';

if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(600000);

let world: P5World,
  app: Awaited<ReturnType<typeof createApplication>>,
  cart: CartService,
  checkout: CheckoutOperations,
  orders: OrderOperations;
const manager = uuidV7(),
  rider = uuidV7();
async function events(type: string, orderId: string): Promise<EventEnvelope[]> {
  const rows = await sql<{
    id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    payload: EventEnvelope['payload'];
    occurred_at: Date;
    correlation_id: string;
  }>`SELECT id,event_type,aggregate_type,aggregate_id,aggregate_version::text,payload,occurred_at,correlation_id FROM outbox_events WHERE event_type=${type} AND payload->>'orderId'=${orderId} ORDER BY occurred_at,id`.execute(
    world.db.db,
  );
  return rows.rows.map((r) => ({
    eventId: r.id,
    eventType: r.event_type,
    schemaVersion: 1,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    payload: r.payload,
    occurredAt: r.occurred_at.toISOString(),
    correlationId: r.correlation_id,
    causationId: null,
  }));
}
async function apply(
  event: EventEnvelope,
  consumer: string,
  handler: (
    tx: Parameters<Parameters<typeof consumeOnce>[3]>[0],
    event: EventEnvelope,
  ) => Promise<void>,
) {
  await consumeOnce(world.db.db, event.eventId, consumer, (tx) => handler(tx, event));
}
beforeAll(
  async () => {
    world = await createP5World();
    await sql`UPDATE stores SET accepts_cod=true,hourly_capacity=100 WHERE id=${world.store}::uuid`.execute(
      world.db.db,
    );
    for (const [key, value] of [
      ['deliveryFeeSlabs', [{ maxOrderValuePaise: null, feePaise: '0' }]],
      ['freeDeliveryThresholdPaise', '0'],
      ['handlingFeePaise', '0'],
      ['smallCartThresholdPaise', '0'],
      ['smallCartFeePaise', '0'],
      ['surgeFeePaise', '0'],
    ] as const)
      await sql`INSERT INTO app_config(key,value) VALUES(${key},${JSON.stringify(value)}::jsonb)`.execute(
        world.db.db,
      );
    await sql`INSERT INTO feature_flags(key,enabled) VALUES('cod_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
      world.db.db,
    );
    for (const [id, role] of [
      [manager, 'STORE_MANAGER'],
      [rider, 'RIDER'],
    ] as const) {
      await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${id},${id + '@example.invalid'},${role})`.execute(
        world.db.db,
      );
      await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,${role})`.execute(
        world.db.db,
      );
    }
    await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${manager}::uuid,${world.store}::uuid,'STORE_MANAGER')`.execute(
      world.db.db,
    );
    await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no) VALUES(${rider}::uuid,'APPROVED','SCOOTER','AUDIT-TEST')`.execute(
      world.db.db,
    );
    await sql`INSERT INTO rider_status(rider_id,online,last_location,last_location_at,last_heartbeat_at) VALUES(${rider}::uuid,true,ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,clock_timestamp(),clock_timestamp())`.execute(
      world.db.db,
    );
    app = await createApplication(
      readEnv({
        NODE_ENV: 'test',
        APP_ROLE: 'all',
        LOG_LEVEL: 'silent',
        DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
        REDIS_URL: world.services.redisUrl,
        ...(world.services.databaseIamUrl
          ? {
              DATABASE_AUTH: 'iam',
              AWS_REGION: process.env.AWS_REGION,
              DB_ACQUIRE_TIMEOUT_MS: '30000',
            }
          : {}),
      }),
      [{ name: 'test', async check() {} }],
    );
    cart = app.get(CART_SERVICE);
    checkout = app.get(CHECKOUT);
    orders = app.get(ORDERS);
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
afterAll(
  async () => {
    await app?.close();
    if (world) await closeP5World(world);
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
async function placed(method: 'GATEWAY' | 'COD' = 'GATEWAY', qty = '2', baseUnit = 'PIECE') {
  const existing = await cart.get(world.customer);
  if (existing) await cart.deleteCart(world.customer, { expectedVersion: existing.version });
  const variant = await world.variant({ stock: 10n, price: 10500n });
  await sql`UPDATE catalog_variants SET barcode=${variant.id},base_unit=${baseUnit} WHERE id=${variant.id}::uuid`.execute(
    world.db.db,
  );
  const active = await cart.getOrCreateActiveCart(world.customer, world.address);
  await cart.putItem(world.customer, variant.id, qty, { expectedVersion: active.version });
  const quoted = await checkout.quote(world.customer, { addressId: world.address });
  const result = await checkout.place(world.customer, {
    quoteId: quoted.quote.quoteId,
    intentId: quoted.intentId,
    method,
    idempotencyOperationId: uuidV7(),
  });
  return { result, variant, quoted };
}
async function capture(
  orderId: string,
  gatewayOrderId: string,
  amountPaise: string,
  paymentId?: string,
) {
  const gateway = app.get<FakeGateway>(PAYMENT_GATEWAY);
  const emitted = gateway.emitCaptured({
    gatewayOrderId,
    amountPaise,
    paymentId,
    eventId: uuidV7(),
  });
  const webhooks = app.get<PaymentWebhookIngest>(PAYMENT_WEBHOOKS);
  const ingested = await webhooks.ingest({
    gateway: 'fake',
    rawBody: emitted.raw,
    signature: emitted.signature,
    eventIdHeader: uuidV7(),
  });
  expect(await webhooks.processOne(ingested.inboxId)).toBe('PROCESSED');
  const consumer = app.get(OrderPaymentEventConsumer);
  for (const event of await events('payments.funding.captured', orderId))
    await apply(event, 'orders', (tx, e) => consumer.handle(tx, e));
}
async function tasks(orderId: string) {
  const config = app.get<AppConfig>(APP_CONFIG),
    pick = new PickConsumer(config),
    dispatch = new DispatchConsumer(config, app.get<DeliveryCodes>(DELIVERY_CODES));
  const event = (await events('ORDER_CONFIRMED', orderId))[0]!;
  await apply(event, 'picking', (tx, e) => pick.handle(tx, e));
  await apply(event, 'dispatch', (tx, e) => dispatch.handle(tx, e));
  const task = (
    await sql<{
      id: string;
    }>`SELECT id FROM pick_tasks WHERE order_id=${orderId}::uuid AND status='PENDING'`.execute(
      world.db.db,
    )
  ).rows[0]!;
  return task.id;
}
it('freezes the selected zone versions when a placed order outlives a zone edit', async () => {
  const { result } = await placed();
  const readSnapshot = async () =>
    (
      await sql<{
        address_snapshot: { zoneId?: string; zoneVersion?: string; cityZoneVersion?: string };
      }>`SELECT address_snapshot FROM orders WHERE id=${result.order.orderId}::uuid`.execute(
        world.db.db,
      )
    ).rows[0]!.address_snapshot;
  const snapshot = (await readSnapshot()) as {
    zoneId?: string;
    zoneVersion?: string;
    cityZoneVersion?: string;
  };
  expect(snapshot.zoneId).toBeTruthy();
  expect(snapshot.zoneVersion).toMatch(/^\d+$/);
  expect(snapshot.cityZoneVersion).toMatch(/^\d+$/);
  await sql`UPDATE zones SET version=version+1 WHERE id=${snapshot.zoneId}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE cities SET zone_version=zone_version+1 WHERE id=${world.city}::uuid`.execute(
    world.db.db,
  );
  expect(await readSnapshot()).toMatchObject({
    zoneId: snapshot.zoneId,
    zoneVersion: snapshot.zoneVersion,
    cityZoneVersion: snapshot.cityZoneVersion,
  });
  const anotherAddress = uuidV7();
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default)
    VALUES(${anotherAddress}::uuid,${world.customer}::uuid,'new road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,false)`.execute(
    world.db.db,
  );
  await orders.changeAddress(result.order.orderId, world.customer, {
    addressId: anotherAddress,
    addressSnapshot: {},
  });
  expect(await readSnapshot()).toMatchObject({
    zoneId: snapshot.zoneId,
    zoneVersion: snapshot.zoneVersion,
    cityZoneVersion: snapshot.cityZoneVersion,
  });
});
it(
  'prepaid checkout, verified capture, real picking/handover, delivery, invoice and inbox settle together',
  async () => {
    const { result, variant } = await placed();
    const orderId = result.order.orderId;
    expect(result.payment?.gatewayOrderId).toBeTruthy();
    await capture(orderId, result.payment!.gatewayOrderId!, result.payment!.amountDuePaise);
    expect((await orders.byId(orderId))?.status).toBe('CONFIRMED');
    const pickId = await tasks(orderId),
      picking = app.get<PickTasks>(PICK_TASKS);
    await picking.claim(manager, pickId, uuidV7());
    await picking.start(manager, pickId, uuidV7());
    const task = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
      (t) => t.id === pickId,
    )!;
    const item = task.items[0]!;
    await picking.pickItem(
      manager,
      pickId,
      item.id,
      { scannedBarcode: variant.id, quantity: '2', batchId: item.fefoSuggestions[0]!.batchId },
      uuidV7(),
    );
    const completeKey = uuidV7();
    await picking.complete(manager, pickId, completeKey);
    await picking.complete(manager, pickId, completeKey);
    await app
      .get<PickPacking>(PICK_PACKING)
      .pack(manager, orderId, { bags: '1', sealCode: 'TEST-SEAL', coldChain: false }, uuidV7());
    const deliveryId = (
      await sql<{
        id: string;
      }>`SELECT id FROM delivery_tasks WHERE order_id=${orderId}::uuid`.execute(world.db.db)
    ).rows[0]!.id;
    const offerId = uuidV7();
    await sql`UPDATE delivery_tasks SET status='OFFERED',offered_rider_id=${rider}::uuid WHERE id=${deliveryId}::uuid`.execute(
      world.db.db,
    );
    await sql`INSERT INTO rider_offers(id,task_id,rider_id,attempt_no,status,expires_at) VALUES(${offerId}::uuid,${deliveryId}::uuid,${rider}::uuid,0,'SENT',clock_timestamp()+interval '1 minute')`.execute(
      world.db.db,
    );
    await sql`UPDATE rider_status SET last_location_at=clock_timestamp(),last_heartbeat_at=clock_timestamp() WHERE rider_id=${rider}::uuid`.execute(
      world.db.db,
    );
    const delivery = app.get<DeliveryTasks>(DELIVERY_TASKS);
    await delivery.accept(rider, offerId, uuidV7());
    await delivery.arrivedAtStore(rider, deliveryId, uuidV7());
    const handover = app.get<HandoverCodes>(HANDOVER_CODES);
    await handover.verify(manager, { orderId, code: (await handover.presentCode(orderId)).code });
    await delivery.pickedUp(rider, deliveryId, uuidV7());
    expect((await orders.byId(orderId))?.status).toBe('OUT_FOR_DELIVERY');
    await delivery.arrived(rider, deliveryId, uuidV7());
    const code = await app.get<OrderCodes>(ORDER_CODES).present(orderId, world.customer);
    const deliverKey = uuidV7();
    await delivery.deliver(rider, deliveryId, { deliveryCode: code.code }, deliverKey);
    await delivery.deliver(rider, deliveryId, { deliveryCode: code.code }, deliverKey);
    const invoiceConsumer = app.get(InvoicingEventConsumer),
      notifications = app.get<NotificationPipeline>(NOTIFICATION_PIPELINE);
    for (const event of await events('ORDER_DELIVERED', orderId)) {
      await apply(event, 'invoicing', (tx, e) => invoiceConsumer.handle(tx, e));
      await apply(event, 'notifications', (tx, e) => notifications.consume(tx, e));
    }
    const invoices = app.get<InvoicingOperations>(INVOICING);
    await invoices.renderDue(20);
    const invoice = await invoices.invoiceForOrder(orderId, world.customer);
    expect(invoice.document.payload.totalPaise).toBe('21000');
    expect(invoice.content).toContain(invoice.document.number);
    const checks = await sql<{
      earnings: string;
      reserved: string;
      on_hand: string;
      invoices: string;
      inbox: string;
    }>`SELECT
  (SELECT count(*)::text FROM rider_earnings WHERE task_id=${deliveryId}::uuid) AS earnings,
  (SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved,
  (SELECT on_hand::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS on_hand,
  (SELECT count(*)::text FROM invoice_documents WHERE order_id=${orderId}::uuid AND kind='INVOICE') AS invoices,
  (SELECT count(*)::text FROM notifications WHERE user_id=${world.customer}::uuid AND channel='INBOX' AND template_key='order.delivered') AS inbox`.execute(
      world.db.db,
    );
    expect(checks.rows[0]).toEqual({
      earnings: '1',
      reserved: '0',
      on_hand: '8',
      invoices: '1',
      inbox: '1',
    });
    const delivered = await orders.byId(orderId, { userId: world.customer });
    expect(delivered?.status).toBe('DELIVERED');
    const fulfilled = delivered!.items.find((line) => BigInt(line.fulfilledQty) > 0n);
    expect(fulfilled?.variantId).toBe(variant.id);
    const earnings = await app.get<RiderEarnings>(RIDER_EARNINGS).forRider(rider);
    expect(
      earnings.items.some((entry) => entry.orderId === orderId && entry.taskId === deliveryId),
    ).toBe(true);
    const ratings = app.get<Ratings>(RATINGS),
      support = app.get<Support>(SUPPORT);
    const rating = await ratings.create(world.customer, orderId, {
      targetType: 'ORDER',
      targetId: delivered!.orderId,
      stars: 1,
      comment: 'Order issue',
    });
    await ratings.create(world.customer, orderId, {
      targetType: 'RIDER',
      targetId: rider,
      stars: 5,
    });
    await ratings.create(world.customer, orderId, {
      targetType: 'PRODUCT',
      targetId: fulfilled!.variantId,
      stars: 5,
    });
    await expect(
      ratings.create(world.otherCustomer, orderId, {
        targetType: 'ORDER',
        targetId: orderId,
        stars: 5,
      }),
    ).rejects.toThrow('RATING_NOT_ALLOWED');
    await ratings.edit(world.customer, orderId, rating, { stars: 2, comment: 'Still needs help' });
    const tickets = await sql<{
      id: string;
    }>`SELECT id FROM support_tickets WHERE incident_key=${`rating:${rating}`}`.execute(
      world.db.db,
    );
    expect(tickets.rows).toHaveLength(1);
    const ticketId = tickets.rows[0]!.id;
    await support.message(world.customer, ticketId, { body: 'Please investigate this delivery' });
    const detail = await support.detail(world.customer, ticketId, false);
    expect(JSON.stringify(detail)).toContain('Please investigate this delivery');
    await expect(support.detail(world.otherCustomer, ticketId, false)).rejects.toThrow(
      'RESOURCE_NOT_FOUND',
    );
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 600000 : 120000,
);
it('cancelled pending checkout releases capacity and stock once, and late capture becomes a refund', async () => {
  const { result, variant } = await placed();
  const orderId = result.order.orderId;
  await orders.cancel(orderId, { type: 'CUSTOMER', id: world.customer }, 'changed mind');
  await orders.cancel(orderId, { type: 'CUSTOMER', id: world.customer }, 'changed mind');
  const stock = await sql<{
    reserved: string;
    claims: string;
  }>`SELECT reserved::text,(SELECT count(*)::text FROM store_capacity_claims WHERE reference=${orderId}) AS claims FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
    world.db.db,
  );
  expect(stock.rows[0]).toEqual({ reserved: '0', claims: '0' });
  await capture(orderId, result.payment!.gatewayOrderId!, result.payment!.amountDuePaise);
  const refunds = app.get<PaymentRefundOperations>(PAYMENT_REFUNDS);
  const committed = await refunds.refundsForOrder(orderId);
  expect(committed).toHaveLength(1);
  expect(committed[0]?.reason).toBe('LATE_CAPTURE');
  await refunds.dispatchRefund(committed[0]!.refundReference);
  expect((await refunds.refundsForOrder(orderId))[0]?.status).toBe('PROCESSED');
  expect((await orders.byId(orderId))?.status).toBe('CANCELLED');
});

it('additional distinct captures are refundable once and cannot refund a different order', async () => {
  const first = await placed();
  const orderId = first.result.order.orderId,
    payment = first.result.payment!;
  await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise, 'pay_' + uuidV7());
  const additional = 'pay_' + uuidV7();
  await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise, additional);
  await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise, additional);
  const refunds = app.get<PaymentRefundOperations>(PAYMENT_REFUNDS),
    found = await refunds.refundsForOrder(orderId);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    sourceId: additional,
    reason: 'DUPLICATE_CAPTURE',
    amountPaise: payment.amountDuePaise,
  });
  const other = await placed();
  await expect(
    refunds.commit({
      orderId: other.result.order.orderId,
      sourceType: 'GATEWAY_CAPTURE',
      sourceId: additional,
      amountPaise: '1',
      destination: 'GATEWAY',
      gatewayPaymentId: additional,
      reason: 'CROSS_ORDER',
    }),
  ).rejects.toThrow('REFUND_LIMIT_EXCEEDED');
  expect((await orders.byId(orderId))?.status).toBe('CONFIRMED');
});

it('a partially picked COD order keeps its reduced expectation after a wrong cash entry', async () => {
  const { result, variant } = await placed('COD');
  const orderId = result.order.orderId;
  const taskId = await tasks(orderId),
    picking = app.get<PickTasks>(PICK_TASKS);
  await picking.claim(manager, taskId, uuidV7());
  await picking.start(manager, taskId, uuidV7());
  const item = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
    (t) => t.id === taskId,
  )!.items[0]!;
  await picking.pickItem(
    manager,
    taskId,
    item.id,
    { scannedBarcode: variant.id, quantity: '1', batchId: item.fefoSuggestions[0]!.batchId },
    uuidV7(),
  );
  await picking.shortItem(manager, taskId, item.id, { reason: 'DAMAGED' }, uuidV7());
  await picking.complete(manager, taskId, uuidV7());
  await app
    .get<PickPacking>(PICK_PACKING)
    .pack(manager, orderId, { bags: '1', sealCode: 'PARTIAL', coldChain: false }, uuidV7());
  const deliveryId = (
    await sql<{
      id: string;
    }>`SELECT id FROM delivery_tasks WHERE order_id=${orderId}::uuid`.execute(world.db.db)
  ).rows[0]!.id;
  const offerId = uuidV7();
  await sql`UPDATE delivery_tasks SET status='OFFERED',offered_rider_id=${rider}::uuid WHERE id=${deliveryId}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO rider_offers(id,task_id,rider_id,attempt_no,status,expires_at) VALUES(${offerId}::uuid,${deliveryId}::uuid,${rider}::uuid,0,'SENT',clock_timestamp()+interval '1 minute')`.execute(
    world.db.db,
  );
  await sql`UPDATE rider_status SET last_location_at=clock_timestamp(),last_heartbeat_at=clock_timestamp() WHERE rider_id=${rider}::uuid`.execute(
    world.db.db,
  );
  const delivery = app.get<DeliveryTasks>(DELIVERY_TASKS);
  expect((await delivery.accept(rider, offerId, uuidV7())).codAmountPaise).toBe('10500');
  await delivery.arrivedAtStore(rider, deliveryId, uuidV7());
  const handover = app.get<HandoverCodes>(HANDOVER_CODES);
  await handover.verify(manager, { orderId, code: (await handover.presentCode(orderId)).code });
  await delivery.pickedUp(rider, deliveryId, uuidV7());
  await delivery.arrived(rider, deliveryId, uuidV7());
  expect(
    await delivery.codCollect(rider, deliveryId, { amountPaise: '10000' }, uuidV7()),
  ).toMatchObject({ expectedPaise: '10500', mismatch: true });
  const code = await app.get<OrderCodes>(ORDER_CODES).present(orderId, world.customer);
  await expect(
    delivery.deliver(rider, deliveryId, { deliveryCode: code.code }, uuidV7()),
  ).rejects.toThrow('COD_AMOUNT_MISMATCH');
  expect(
    await delivery.codCollect(rider, deliveryId, { amountPaise: '10500' }, uuidV7()),
  ).toMatchObject({ expectedPaise: '10500', mismatch: false });
  await delivery.deliver(rider, deliveryId, { deliveryCode: code.code }, uuidV7());
  expect((await orders.byId(orderId))?.status).toBe('DELIVERED');
  const invoiceConsumer = app.get(InvoicingEventConsumer);
  for (const event of await events('ORDER_DELIVERED', orderId))
    await apply(event, 'invoicing', (tx, e) => invoiceConsumer.handle(tx, e));
  const invoices = app.get<InvoicingOperations>(INVOICING);
  await invoices.renderDue(20);
  expect(
    (await invoices.invoiceForOrder(orderId, world.customer)).document.payload.totalPaise,
  ).toBe('10500');
});

it('holds an early capture webhook until its gateway attempt mapping is committed', async () => {
  const { result } = await placed();
  const payment = result.payment!;
  const gateway = app.get<FakeGateway>(PAYMENT_GATEWAY);
  const eventId = uuidV7();
  const emitted = gateway.emitCaptured({
    gatewayOrderId: payment.gatewayOrderId!,
    amountPaise: payment.amountDuePaise,
    eventId,
  });
  // Simulate the interval before the create-order result is persisted.
  await sql`UPDATE payment_attempts SET gateway_order_id=NULL WHERE id=${payment.attemptId}::uuid`.execute(
    world.db.db,
  );
  const webhooks = app.get<PaymentWebhookIngest>(PAYMENT_WEBHOOKS);
  const received = await webhooks.ingest({
    gateway: 'fake',
    rawBody: emitted.raw,
    signature: emitted.signature,
    eventIdHeader: eventId,
  });
  expect(await webhooks.processOne(received.inboxId)).toBe('RETRY_SCHEDULED');
  const pending = await sql<{
    state: string;
  }>`SELECT state FROM gateway_event_inbox WHERE id=${received.inboxId}::uuid`.execute(world.db.db);
  expect(pending.rows[0]?.state).toBe('PENDING');
  expect(await events('payments.funding.captured', result.order.orderId)).toHaveLength(0);
  await sql`UPDATE payment_attempts SET gateway_order_id=${payment.gatewayOrderId!} WHERE id=${payment.attemptId}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE gateway_event_inbox SET next_attempt_at=clock_timestamp() WHERE id=${received.inboxId}::uuid`.execute(
    world.db.db,
  );
  expect(await webhooks.processOne(received.inboxId)).toBe('PROCESSED');
  expect(await webhooks.processOne(received.inboxId)).toBe('SKIPPED');
  expect(await events('payments.funding.captured', result.order.orderId)).toHaveLength(1);
  const replay = await webhooks.ingest({
    gateway: 'fake',
    rawBody: emitted.raw,
    signature: emitted.signature,
    eventIdHeader: eventId,
  });
  expect(replay.duplicate).toBe(true);
  expect(replay.inboxId).toBe(received.inboxId);
  const changed = gateway.emitCaptured({
    gatewayOrderId: payment.gatewayOrderId!,
    amountPaise: payment.amountDuePaise,
    eventId,
    paymentId: 'different-payment',
  });
  const conflict = await webhooks.ingest({
    gateway: 'fake',
    rawBody: changed.raw,
    signature: changed.signature,
    eventIdHeader: eventId,
  });
  expect(conflict).toMatchObject({
    accepted: false,
    state: 'QUARANTINED',
    quarantineReason: 'CHANGED_BODY',
  });
});
it('authenticates payment webhook raw bytes and quarantines invalid signatures over HTTP', async () => {
  const { result } = await placed();
  const gateway = app.get<FakeGateway>(PAYMENT_GATEWAY);
  const emitted = gateway.emitCaptured({
    gatewayOrderId: result.payment!.gatewayOrderId!,
    amountPaise: result.payment!.amountDuePaise,
  });
  const http = app.getHttpAdapter().getInstance();
  const eventId = uuidV7();
  const bad = await http.inject({
    method: 'POST',
    url: '/v1/customer/webhooks/payments/fake',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': 'bad',
      'x-razorpay-event-id': eventId,
    },
    payload: Buffer.from(emitted.raw),
  });
  expect(bad.statusCode).toBe(200);
  expect(bad.json()).toEqual({ received: false });
  const valid = await http.inject({
    method: 'POST',
    url: '/v1/customer/webhooks/payments/fake',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': emitted.signature,
      'x-razorpay-event-id': eventId,
    },
    payload: Buffer.from(emitted.raw),
  });
  expect(valid.statusCode).toBe(200);
  expect(valid.json()).toEqual({ received: true });
  const records = await sql<{
    state: string;
    signature_valid: boolean;
  }>`SELECT state,signature_valid FROM gateway_event_inbox WHERE gateway='fake' AND (gateway_event_id=${eventId} OR gateway_event_id LIKE 'invalid-%') ORDER BY created_at DESC LIMIT 2`.execute(
    world.db.db,
  );
  expect(records.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: 'QUARANTINED', signature_valid: false }),
      expect.objectContaining({ state: 'PENDING', signature_valid: true }),
    ]),
  );
});
it('customer retries share the unresolved attempt and a verified provider capture confirms without a webhook', async () => {
  const { result } = await placed(),
    orderId = result.order.orderId,
    payment = result.payment!;
  const service = app.get<CustomerPayments>(CHECKOUT_PAYMENTS);
  const retries = await Promise.all(
    Array.from({ length: 5 }, () => service.retry(world.customer, orderId, uuidV7())),
  );
  expect(new Set(retries.map((r) => r?.attemptId))).toEqual(new Set([payment.attemptId]));
  await expect(service.status(world.otherCustomer, orderId)).rejects.toThrow('ORDER_NOT_FOUND');
  const http = app.getHttpAdapter().getInstance();
  async function issue(sub: string): Promise<string> {
    const response = await http.inject({
      method: 'POST',
      url: '/dev/auth/token',
      payload: { pool: 'CUSTOMER', sub, audience: 'customer', tokenUse: 'access' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().token as string;
  }
  const ownerToken = await issue('p5-customer');
  const otherToken = await issue('p5-other');
  for (const path of [`/v1/customer/orders/${orderId}`, `/v1/customer/payments/${orderId}`]) {
    const own = await http.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(own.statusCode).toBe(200);
    const foreign = await http.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(foreign.statusCode).toBe(404);
  }
  const foreignRetry = await http.inject({
    method: 'POST',
    url: `/v1/customer/payments/${orderId}/retry`,
    headers: { authorization: `Bearer ${otherToken}`, 'idempotency-key': uuidV7() },
  });
  expect(foreignRetry.statusCode).toBe(404);
  const gateway = app.get<FakeGateway>(PAYMENT_GATEWAY),
    emitted = gateway.emitCaptured({
      gatewayOrderId: payment.gatewayOrderId!,
      amountPaise: payment.amountDuePaise,
    });
  const input = {
    attemptId: payment.attemptId,
    gatewayOrderId: payment.gatewayOrderId!,
    gatewayPaymentId: emitted.paymentId,
    signature: 'bad',
  };
  await expect(service.verify(world.customer, orderId, input)).rejects.toThrow(
    'PAYMENT_SIGNATURE_INVALID',
  );
  input.signature = FakeGateway.checkoutSignature(
    input.gatewayOrderId,
    input.gatewayPaymentId,
    'keysecret',
  );
  expect((await service.verify(world.customer, orderId, input)).attempt.status).toBe('CAPTURED');
  const consumer = app.get(OrderPaymentEventConsumer);
  for (const event of await events('payments.funding.captured', orderId))
    await apply(event, 'orders', (tx, e) => consumer.handle(tx, e));
  expect((await orders.byId(orderId))?.status).toBe('CONFIRMED');
});

it.each([false, true])(
  'a capture after the payment window expires atomically refunds or reinstates (flag=%s)',
  async (reinstate) => {
    const { result, variant } = await placed(),
      orderId = result.order.orderId,
      payment = result.payment!;
    await sql`INSERT INTO feature_flags(key,enabled) VALUES('reinstate_expired_orders',${reinstate}) ON CONFLICT(key) DO UPDATE SET enabled=EXCLUDED.enabled`.execute(
      world.db.db,
    );
    await sql`UPDATE orders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${orderId}::uuid`.execute(
      world.db.db,
    );
    await sql`UPDATE inventory_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE order_id=${orderId}::uuid AND state='HELD'`.execute(
      world.db.db,
    );
    await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise);
    expect((await orders.byId(orderId))?.status).toBe(reinstate ? 'CONFIRMED' : 'EXPIRED');
    const refunds = await app
      .get<PaymentRefundOperations>(PAYMENT_REFUNDS)
      .refundsForOrder(orderId);
    expect(refunds).toHaveLength(reinstate ? 0 : 1);
    const stock = (
      await sql<{
        reserved: string;
      }>`SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
        world.db.db,
      )
    ).rows[0]!;
    expect(stock.reserved).toBe(reinstate ? '2' : '0');
    if (reinstate)
      expect(
        (await app.get<OrderCodes>(ORDER_CODES).present(orderId, world.customer)).code,
      ).toMatch(/^\d{4}$/);
    await sql`UPDATE feature_flags SET enabled=false WHERE key='reinstate_expired_orders'`.execute(
      world.db.db,
    );
  },
);

it('disconnected picking returns to the queue with progress, and resumes the same order state', async () => {
  const { result, variant } = await placed('COD'),
    orderId = result.order.orderId,
    id = await tasks(orderId),
    picking = app.get<PickTasks>(PICK_TASKS);
  await picking.claim(manager, id, uuidV7());
  await picking.start(manager, id, uuidV7());
  const item = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
    (t) => t.id === id,
  )!.items[0]!;
  await picking.pickItem(
    manager,
    id,
    item.id,
    { scannedBarcode: variant.id, quantity: '1', batchId: item.fefoSuggestions[0]!.batchId },
    uuidV7(),
  );
  await sql`UPDATE pick_tasks SET last_activity_at=clock_timestamp()-interval '20 minutes' WHERE id=${id}::uuid`.execute(
    world.db.db,
  );
  await recoverDisconnected(world.db.db, app.get<AppConfig>(APP_CONFIG));
  const returned = (
    await picking.queue(manager, { storeId: world.store, scope: 'QUEUE' })
  ).items.find((t) => t.id === id)!;
  expect(returned.assignedTo).toBeNull();
  expect(returned.items[0]?.pickedQty).toBe('1');
  await picking.claim(manager, id, uuidV7());
  await picking.start(manager, id, uuidV7());
  await picking.heartbeat(manager, id);
  expect((await orders.byId(orderId))?.status).toBe('PICKING');
});

it('manual dispatch respects rider breaks, transfers capacity, and records a single replayable assignment', async () => {
  const { result } = await placed('COD'),
    orderId = result.order.orderId;
  await tasks(orderId);
  const ops = app.get<RiderOperations>(RIDER_OPERATIONS),
    assign = app.get<DeliveryAssignment>(DELIVERY_ASSIGNMENT);
  const next = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${next}::uuid,'WORKFORCE',${next},${next + '@example.invalid'},'second rider')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${next}::uuid,'RIDER')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no) VALUES(${next}::uuid,'APPROVED','SCOOTER','TEST-2')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO rider_status(rider_id,online,last_location,last_location_at,last_heartbeat_at) VALUES(${next}::uuid,true,ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,clock_timestamp(),clock_timestamp())`.execute(
    world.db.db,
  );
  await ops.setBreak(next, true);
  await expect(assign.assign(orderId, next, world.admin, 'ops repair', uuidV7())).rejects.toThrow(
    'RIDER_OFFLINE',
  );
  await ops.setBreak(next, false);
  await sql`UPDATE rider_status SET last_location_at=clock_timestamp(),last_heartbeat_at=clock_timestamp() WHERE rider_id IN (${next}::uuid,${rider}::uuid)`.execute(
    world.db.db,
  );
  const key = uuidV7(),
    first = await assign.assign(orderId, next, world.admin, 'ops repair', key);
  expect((await assign.assign(orderId, next, world.admin, 'ops repair', key)).id).toBe(first.id);
  await sql`UPDATE rider_status SET last_location_at=clock_timestamp(),last_heartbeat_at=clock_timestamp() WHERE rider_id=${rider}::uuid`.execute(
    world.db.db,
  );
  const moved = await assign.assign(
    orderId,
    rider,
    world.admin,
    'transfer before pickup',
    uuidV7(),
  );
  expect(moved.riderId).toBe(rider);
  await expect(app.get<DeliveryTasks>(DELIVERY_TASKS).contact(next, first.id)).rejects.toThrow(
    'RESOURCE_NOT_FOUND',
  );
  const counts = (
    await sql<{
      active_tasks: number;
    }>`SELECT active_tasks FROM rider_status WHERE rider_id=${next}::uuid`.execute(world.db.db)
  ).rows[0]!;
  expect(counts.active_tasks).toBe(0);
  const history = (
    await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM task_assignment_history WHERE task_id=${first.id}::uuid`.execute(
      world.db.db,
    )
  ).rows[0]!;
  expect(history.n).toBe('2');
  await orders.cancel(orderId, { type: 'ADMIN', id: world.admin }, 'test cleanup');
  await app
    .get<DeliveryTaskCancellation>(DELIVERY_TASK_CANCELLATION)
    .cancel(orderId, 'test cleanup');
});

async function packedAndAssigned() {
  const { result, variant } = await placed();
  const orderId = result.order.orderId,
    payment = result.payment!;
  await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise);
  const taskId = await tasks(orderId),
    picking = app.get<PickTasks>(PICK_TASKS);
  await picking.claim(manager, taskId, uuidV7());
  await picking.start(manager, taskId, uuidV7());
  const item = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
    (t) => t.id === taskId,
  )!.items[0]!;
  await picking.pickItem(
    manager,
    taskId,
    item.id,
    { scannedBarcode: variant.id, quantity: '2', batchId: item.fefoSuggestions[0]!.batchId },
    uuidV7(),
  );
  await picking.complete(manager, taskId, uuidV7());
  await app
    .get<PickPacking>(PICK_PACKING)
    .pack(manager, orderId, { bags: '1', sealCode: 'RECOVERY', coldChain: false }, uuidV7());
  await sql`UPDATE rider_status SET last_location_at=clock_timestamp(),last_heartbeat_at=clock_timestamp() WHERE rider_id=${rider}::uuid`.execute(
    world.db.db,
  );
  const delivery = app.get<DeliveryTasks>(DELIVERY_TASKS),
    assigned = await app
      .get<DeliveryAssignment>(DELIVERY_ASSIGNMENT)
      .assign(orderId, rider, world.admin, 'fulfillment test', uuidV7());
  await delivery.arrivedAtStore(rider, assigned.id, uuidV7());
  const handover = app.get<HandoverCodes>(HANDOVER_CODES);
  await handover.verify(manager, { orderId, code: (await handover.presentCode(orderId)).code });
  await delivery.pickedUp(rider, assigned.id, uuidV7());
  return { orderId, variant, delivery, id: assigned.id };
}

it('all-short picking cancels through real compensation and releases stock and capacity', async () => {
  const { result, variant } = await placed('COD'),
    orderId = result.order.orderId,
    id = await tasks(orderId),
    picking = app.get<PickTasks>(PICK_TASKS);
  await picking.claim(manager, id, uuidV7());
  await picking.start(manager, id, uuidV7());
  const item = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
    (t) => t.id === id,
  )!.items[0]!;
  await picking.shortItem(manager, id, item.id, { reason: 'NOT_FOUND' }, uuidV7());
  await picking.complete(manager, id, uuidV7());
  expect((await orders.byId(orderId))?.status).toBe('CANCELLED');
  const state = (
    await sql<{
      reserved: string;
      tasks: string;
    }>`SELECT reserved::text,(SELECT count(*)::text FROM pick_tasks WHERE order_id=${orderId}::uuid AND status='CANCELLED') AS tasks
   FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
      world.db.db,
    )
  ).rows[0]!;
  expect(state).toEqual({ reserved: '0', tasks: '1' });
});

it('a failed parcel keeps custody until a full return is quarantined and refunded once', async () => {
  const { orderId, variant, delivery, id } = await packedAndAssigned();
  await delivery.arrived(rider, id, uuidV7());
  await delivery.fail(rider, id, { reason: 'PACKAGE_DAMAGED' }, uuidV7());
  expect((await orders.byId(orderId))?.status).toBe('DELIVERY_FAILED');
  const returns = app.get<DeliveryReturn>(DELIVERY_RETURN),
    items = [{ variantId: variant.id, quantity: '2', expiresAt: null }],
    key = uuidV7();
  await expect(
    returns.receive(
      manager,
      orderId,
      'damaged return',
      [{ ...items[0]!, quantity: '3' }],
      uuidV7(),
    ),
  ).rejects.toThrow('RETURN_QUANTITY_MISMATCH');
  const received = await returns.receive(manager, orderId, 'damaged return', items, key);
  expect(await returns.receive(manager, orderId, 'damaged return', items, key)).toEqual(received);
  expect((await orders.byId(orderId))?.status).toBe('RETURNED_TO_STORE');
  const stock = (
    await sql<{
      state: string;
      on_hand: string;
      reserved: string;
    }>`SELECT b.state,b.on_hand::text,b.reserved::text FROM inventory_returns r JOIN inventory_batches b ON b.id=r.batch_id WHERE r.id=${received.returnIds[0]!}::uuid`.execute(
      world.db.db,
    )
  ).rows[0]!;
  expect(stock).toEqual({ state: 'QUARANTINED', on_hand: '2', reserved: '0' });
  expect(
    await app.get<PaymentRefundOperations>(PAYMENT_REFUNDS).refundsForOrder(orderId),
  ).toHaveLength(1);
});

it('contactless POD must be privately uploaded by the assigned rider and bound to this task', async () => {
  const { orderId, delivery, id } = await packedAndAssigned();
  await delivery.arrived(rider, id, uuidV7());
  const pod = app.get<DeliveryPod>(DELIVERY_POD),
    bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  await expect(pod.target(manager, id, 'image/jpeg', bytes.length)).rejects.toThrow(
    'RESOURCE_NOT_FOUND',
  );
  const target = await pod.target(rider, id, 'image/jpeg', bytes.length);
  await expect(
    delivery.deliver(rider, id, { podMediaId: target.mediaId }, uuidV7()),
  ).rejects.toThrow('MEDIA_NOT_FOUND');
  const uploads = app.get<LocalPrivateUploads>(PRIVATE_UPLOADS);
  await uploads.upload(target.mediaId, target.fields.authorization!.replace(/^Bearer /, ''), bytes);
  await pod.complete(rider, id, target.mediaId);
  await delivery.deliver(rider, id, { podMediaId: target.mediaId }, uuidV7());
  expect((await orders.byId(orderId))?.status).toBe('DELIVERED');
});

it('approved order repair restricts states and compensates stock without duplicate financial effects', async () => {
  const { result, variant } = await placed();
  const orderId = result.order.orderId;
  const administration = app.get<OrderAdministration>(ORDER_ADMINISTRATION);
  const checker = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${checker}::uuid,'WORKFORCE',${checker},${checker + '@example.invalid'},'checker')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${checker}::uuid,'SUPER_ADMIN')`.execute(
    world.db.db,
  );
  const input = { state: 'EXPIRED' as const, reason: 'repair pending payment' };
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${world.admin}::uuid,'SUPER_ADMIN') ON CONFLICT DO NOTHING`.execute(
    world.db.db,
  );
  const key = uuidV7();
  const request = await administration.requestRepair(world.admin, orderId, input, key);
  expect((await orders.byId(orderId))?.status).toBe('PENDING_PAYMENT');
  await administration.approve(world.admin, request);
  expect((await orders.byId(orderId))?.status).toBe('EXPIRED');
  const replay = await administration.requestRepair(world.admin, orderId, input, key);
  await administration.approve(checker, replay);
  const state = await sql<{
    reserved: string;
    refunds: string;
    active_tasks: string;
  }>`SELECT (SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved,(SELECT count(*)::text FROM payment_refunds WHERE order_id=${orderId}::uuid) AS refunds,(SELECT count(*)::text FROM delivery_tasks WHERE order_id=${orderId}::uuid AND status NOT IN ('CANCELLED','FAILED','DELIVERED')) AS active_tasks`.execute(
    world.db.db,
  );
  expect(state.rows[0]).toEqual({ reserved: '0', refunds: '0', active_tasks: '0' });
  await expect(
    orders.forceState(orderId, 'DELIVERED', 'arbitrary repair', checker),
  ).rejects.toThrow('ILLEGAL_STATE_TRANSITION');
});
it('approved manual refunds have stable effects and enforce the paid source cap', async () => {
  const { result } = await placed(),
    orderId = result.order.orderId,
    payment = result.payment!;
  await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise);
  const administration = app.get<OrderAdministration>(ORDER_ADMINISTRATION),
    checker = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${checker}::uuid,'WORKFORCE',${checker},${checker + '@example.invalid'},'checker')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${checker}::uuid,'SUPER_ADMIN')`.execute(
    world.db.db,
  );
  const key = uuidV7(),
    input = { amountPaise: '1000', reason: 'approved adjustment' },
    request = await administration.requestRefund(world.admin, orderId, input, key);
  await administration.approve(world.admin, request);
  const replay = await administration.requestRefund(world.admin, orderId, input, key);
  await administration.approve(checker, replay);
  const refunds = app.get<PaymentRefundOperations>(PAYMENT_REFUNDS);
  expect(await refunds.refundsForOrder(orderId)).toHaveLength(1);
  const excessive = await administration.requestRefund(
    world.admin,
    orderId,
    { amountPaise: payment.amountDuePaise, reason: 'too much' },
    uuidV7(),
  );
  await expect(administration.approve(checker, excessive)).rejects.toThrow('REFUND_LIMIT_EXCEEDED');
  expect(await refunds.refundsForOrder(orderId)).toHaveLength(1);
});

it('mixed wallet funding reverses its own buckets once and cannot also be refunded after cancellation', async () => {
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    world.db.db,
  );
  const wallet = app.get<WalletSpender>(WALLET_SPENDER),
    views = app.get<WalletViews>(WALLET_VIEWS);
  await wallet.credit({
    userId: world.customer,
    bucket: 'promo',
    amountPaise: '7500',
    reason: 'PROMO_GRANT',
    refType: 'TEST',
    refId: uuidV7(),
  });
  await wallet.credit({
    userId: world.customer,
    bucket: 'cash',
    amountPaise: '2500',
    reason: 'TOPUP_CREDIT',
    refType: 'TEST',
    refId: uuidV7(),
  });
  const { result } = await placed(),
    orderId = result.order.orderId;
  expect(result.payment!.amountDuePaise).toBe('11000');
  expect(await views.balances(world.customer)).toMatchObject({ cashPaise: '0', promoPaise: '0' });
  await orders.cancel(orderId, { type: 'CUSTOMER', id: world.customer }, 'mixed cancellation');
  await orders.cancel(orderId, { type: 'CUSTOMER', id: world.customer }, 'mixed cancellation');
  expect(await views.balances(world.customer)).toMatchObject({
    cashPaise: '2500',
    promoPaise: '7500',
  });
  const reconciled = await sql<{
    bucket: string;
    ledger: string;
    balance: string;
  }>`SELECT l.bucket,sum(l.delta_paise)::text AS ledger,
    CASE WHEN l.bucket='cash' THEN a.cash_balance_paise ELSE a.promo_balance_paise END::text AS balance
    FROM wallet_ledger l JOIN wallet_accounts a ON a.id=l.account_id WHERE a.user_id=${world.customer}::uuid
    GROUP BY l.bucket,a.cash_balance_paise,a.promo_balance_paise ORDER BY l.bucket`.execute(
    world.db.db,
  );
  expect(reconciled.rows).toEqual([
    { bucket: 'cash', ledger: '2500', balance: '2500' },
    { bucket: 'promo', ledger: '7500', balance: '7500' },
  ]);
  const lots = await sql<{
    remaining: string;
  }>`SELECT COALESCE(sum(p.remaining_paise),0)::text AS remaining FROM wallet_promo_lots p
    JOIN wallet_accounts a ON a.id=p.account_id WHERE a.user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  expect(lots.rows[0]?.remaining).toBe('7500');
  const refunds = app.get<PaymentRefundOperations>(PAYMENT_REFUNDS);
  expect(
    (await refunds.refundableCapacity(orderId)).filter((c) => c.sourceType === 'WALLET_DEBIT'),
  ).toEqual([
    {
      sourceType: 'WALLET_DEBIT',
      sourceId: orderId,
      fundedPaise: '0',
      committedPaise: '0',
      availablePaise: '0',
    },
  ]);
  await expect(
    refunds.commit({
      orderId,
      sourceType: 'WALLET_DEBIT',
      sourceId: orderId,
      amountPaise: '1',
      destination: 'WALLET',
    }),
  ).rejects.toThrow('REFUND_LIMIT_EXCEEDED');
  await sql`UPDATE feature_flags SET enabled=false WHERE key='wallet_enabled'`.execute(world.db.db);
});

it('invoice rollback and concurrent issuance consume one number, and a later refund creates one immutable credit note', async () => {
  const row = (
    await sql<{
      id: string;
    }>`SELECT id FROM orders WHERE status='DELIVERED' AND payment_method='GATEWAY'
  AND NOT EXISTS(SELECT 1 FROM invoice_documents d WHERE d.order_id=orders.id AND kind='INVOICE') ORDER BY placed_at LIMIT 1`.execute(
      world.db.db,
    )
  ).rows[0];
  if (!row) throw new Error('missing delivered invoice fixture');
  const invoices = app.get<InvoicingOperations>(INVOICING);
  await expect(
    world.db.db.transaction().execute(async (tx) => {
      await invoices.issueForDeliveredOrder(row.id, tx);
      throw new Error('rollback issuance');
    }),
  ).rejects.toThrow('rollback issuance');
  const issued = await Promise.all(
    Array.from({ length: 4 }, () =>
      world.db.db.transaction().execute((tx) => invoices.issueForDeliveredOrder(row.id, tx)),
    ),
  );
  expect(new Set(issued.map((d) => d?.documentId)).size).toBe(1);
  const before = await invoices.invoiceForOrder(row.id, world.customer),
    refunds = app.get<PaymentRefundOperations>(PAYMENT_REFUNDS);
  const source = (await refunds.refundableCapacity(row.id)).find(
    (c) => c.sourceType === 'GATEWAY_CAPTURE',
  )!;
  await refunds.commit({
    orderId: row.id,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    gatewayPaymentId: source.sourceId,
    amountPaise: '1000',
    destination: 'GATEWAY',
    reason: 'ADMIN_REFUND',
    refundReference: 'post-invoice-test',
  });
  const consumer = app.get(InvoicingEventConsumer);
  for (const event of await events('payments.refund.settled', row.id)) {
    await apply(event, 'invoicing', (tx, e) => consumer.handle(tx, e));
    await apply(event, 'invoicing', (tx, e) => consumer.handle(tx, e));
  }
  const notes = (
    await sql<{
      payload: { totalPaise: string; netChargePaise: string };
      credit_note_for: string;
    }>`SELECT payload,credit_note_for FROM invoice_documents WHERE order_id=${row.id}::uuid AND kind='CREDIT_NOTE'`.execute(
      world.db.db,
    )
  ).rows;
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    credit_note_for: before.document.documentId,
    payload: { totalPaise: '1000', netChargePaise: '1000' },
  });
  expect((await invoices.invoiceForOrder(row.id, world.customer)).document.payload).toEqual(
    before.document.payload,
  );
  const sequences = (
    await sql<{
      seq: string;
    }>`SELECT seq_no::text AS seq FROM invoice_documents ORDER BY seq_no`.execute(world.db.db)
  ).rows.map((d) => Number(d.seq));
  expect(sequences).toEqual(sequences.map((_, i) => i + 1));
});

it('weighted picking uses configured tolerance and settles the actual quantity', async () => {
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${world.admin}::uuid,'SUPER_ADMIN') ON CONFLICT DO NOTHING`.execute(
    world.db.db,
  );
  const { result, variant } = await placed('COD', '2', 'GRAM'),
    orderId = result.order.orderId,
    id = await tasks(orderId),
    picking = app.get<PickTasks>(PICK_TASKS);
  await picking.claim(manager, id, uuidV7());
  await picking.start(manager, id, uuidV7());
  const item = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
    (t) => t.id === id,
  )!.items[0]!;
  await picking.pickItem(
    manager,
    id,
    item.id,
    { scannedBarcode: variant.id, quantity: '1', batchId: item.fefoSuggestions[0]!.batchId },
    uuidV7(),
  );
  await expect(picking.complete(manager, id, uuidV7())).rejects.toThrow(
    'WEIGHT_TOLERANCE_EXCEEDED',
  );
  const config = app.get<AdminConfig>(ADMIN_CONFIG);
  await config.update(world.admin, 'pickingWeightToleranceBps', 5000);
  expect((await picking.complete(manager, id, uuidV7())).status).toBe('COMPLETED');
  expect((await orders.byId(orderId))?.items[0]).toMatchObject({
    fulfilledQty: '1',
    shortQty: '1',
  });
  await config.update(world.admin, 'pickingWeightToleranceBps', 0);
});

it('reorder creates a fresh cart and reports unavailable historical items instead of failing', async () => {
  const { result, variant } = await placed(),
    old = await cart.get(world.customer);
  await sql`UPDATE catalog_products SET published=false WHERE id=${world.product}::uuid`.execute(
    world.db.db,
  );
  try {
    const reordered = await orders.reorder(result.order.orderId, world.customer);
    expect(reordered.cartId).not.toBe(old?.cartId);
    expect(reordered.added).toEqual([]);
    expect(reordered.issues).toEqual([{ variantId: variant.id, code: 'ITEM_UNAVAILABLE' }]);
  } finally {
    await sql`UPDATE catalog_products SET published=true WHERE id=${world.product}::uuid`.execute(
      world.db.db,
    );
  }
});

it('an expired committed batch emits one shortfall and cancels through real compensation', async () => {
  const { result, variant } = await placed('COD'),
    orderId = result.order.orderId,
    pickId = await tasks(orderId);
  await sql`UPDATE inventory_batches SET expires_at=clock_timestamp()-interval '1 second' WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
    world.db.db,
  );
  const expiry = app.get(InventoryExpiry);
  await expiry.writeOffExpired(100);
  await expiry.writeOffExpired(100);
  const before = (
    await sql<{
      on_hand: string;
      reserved: string;
      quantity: string;
    }>`SELECT b.on_hand::text,b.reserved::text,s.quantity::text
  FROM inventory_batches b JOIN inventory_shortfall_obligations s ON s.batch_id=b.id WHERE s.order_id=${orderId}::uuid AND s.resolved_at IS NULL`.execute(
      world.db.db,
    )
  ).rows[0]!;
  expect(before).toEqual({ on_hand: '2', reserved: '2', quantity: '2' });
  const outbox = await events('inventory.shortfall_detected', orderId);
  expect(outbox).toHaveLength(1);
  const consumer = new InventoryShortfallConsumer(
    app.get<OrderCancellation>(ORDER_CANCELLATION),
    app.get<PickCancellation>(PICK_CANCELLATION),
  );
  for (const event of outbox) {
    await apply(event, 'inventory-shortfalls', (tx, e) => consumer.handle(tx, e));
    await apply(event, 'inventory-shortfalls', (tx, e) => consumer.handle(tx, e));
  }
  expect((await orders.byId(orderId))?.status).toBe('CANCELLED');
  const after = (
    await sql<{ reserved: string; unresolved: string; status: string; claims: string }>`SELECT
  (SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved,
  (SELECT count(*)::text FROM inventory_shortfall_obligations WHERE order_id=${orderId}::uuid AND resolved_at IS NULL) AS unresolved,
  (SELECT status FROM pick_tasks WHERE id=${pickId}::uuid) AS status,
  (SELECT count(*)::text FROM store_capacity_claims WHERE reference=${orderId}) AS claims`.execute(
      world.db.db,
    )
  ).rows[0]!;
  expect(after).toEqual({ reserved: '0', unresolved: '0', status: 'CANCELLED', claims: '0' });
  await expiry.writeOffExpired(100);
  expect(
    (
      await sql<{
        on_hand: string;
      }>`SELECT on_hand::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
        world.db.db,
      )
    ).rows[0]?.on_hand,
  ).toBe('0');
});

it('cancelling a packed parcel returns picked warehouse goods to quarantine once before QC', async () => {
  const { result, variant } = await placed(),
    orderId = result.order.orderId,
    payment = result.payment!;
  await capture(orderId, payment.gatewayOrderId!, payment.amountDuePaise);
  const id = await tasks(orderId),
    picking = app.get<PickTasks>(PICK_TASKS);
  await picking.claim(manager, id, uuidV7());
  await picking.start(manager, id, uuidV7());
  const item = (await picking.queue(manager, { storeId: world.store, scope: 'MINE' })).items.find(
    (t) => t.id === id,
  )!.items[0]!;
  await picking.pickItem(
    manager,
    id,
    item.id,
    { scannedBarcode: variant.id, quantity: '2', batchId: item.fefoSuggestions[0]!.batchId },
    uuidV7(),
  );
  await picking.complete(manager, id, uuidV7());
  await app
    .get<PickPacking>(PICK_PACKING)
    .pack(manager, orderId, { bags: '1', sealCode: 'CANCELLED', coldChain: false }, uuidV7());
  await orders.cancel(orderId, { type: 'ADMIN', id: world.admin }, 'warehouse cancellation');
  await orders.cancel(orderId, { type: 'ADMIN', id: world.admin }, 'warehouse cancellation');
  const state = (
    await sql<{
      id: string;
      status: string;
      on_hand: string;
      reserved: string;
      available: string;
    }>`SELECT r.id,r.status,i.on_hand::text,i.reserved::text,a.available::text
  FROM inventory_returns r JOIN store_inventory i ON i.store_id=r.store_id AND i.variant_id=r.variant_id
  JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id
  WHERE r.order_id=${orderId}::uuid`.execute(world.db.db)
  ).rows;
  expect(state).toHaveLength(1);
  expect(state[0]).toMatchObject({
    status: 'QUARANTINED',
    on_hand: '10',
    reserved: '0',
    available: '8',
  });
  expect(
    await app.get<PaymentRefundOperations>(PAYMENT_REFUNDS).refundsForOrder(orderId),
  ).toHaveLength(1);
  await app
    .get<InventoryReturns>(INVENTORY_RETURNS)
    .inspectReturn(manager, state[0]!.id, 'APPROVE', 'sealed warehouse parcel');
  expect(
    (
      await sql<{
        available: string;
      }>`SELECT available::text FROM inventory_saleable_availability WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
        world.db.db,
      )
    ).rows[0]?.available,
  ).toBe('10');
});
