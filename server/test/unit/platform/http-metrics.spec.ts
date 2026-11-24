import { HttpMetrics, type MetricStage } from '../../../src/platform/metrics/http-metrics.js';

test('records bounded customer route and dependency stages without request identifiers', () => {
  const metrics = new HttpMetrics();
  metrics.observe('PUT', '/v1/customer/cart/items/private-variant?token=private-token', 200, 300);
  metrics.observe('POST', '/v1/customer/checkout/place', 503, 1_500);
  metrics.observe('GET', '/v1/customer/orders/private-order', 200, 200);
  metrics.observe('GET', '/v1/customer/unrecognised/private-value', 404, 10);
  metrics.observeStage('db_acquire', 600);
  metrics.observeStage('not-a-safe-stage' as MetricStage, 1);

  const output = metrics.render();
  expect(output).toContain(
    'delivery_http_request_duration_seconds_count{method="PUT",audience="customer",status_class="2xx"} 1',
  );
  expect(output).toContain(
    'delivery_customer_route_duration_seconds_count{method="PUT",route="cart_item",status_class="2xx"} 1',
  );
  expect(output).toContain(
    'delivery_customer_route_duration_seconds_count{method="POST",route="checkout_place",status_class="5xx"} 1',
  );
  expect(output).toContain(
    'delivery_customer_route_duration_seconds_count{method="GET",route="order_detail",status_class="2xx"} 1',
  );
  expect(output).toContain(
    'delivery_dependency_stage_duration_seconds_count{stage="db_acquire"} 1',
  );
  for (const secret of [
    'private-variant',
    'private-token',
    'private-order',
    'private-value',
    'not-a-safe-stage',
  ])
    expect(output).not.toContain(secret);
});

test('labels favorites, catalog home/category/preview and delivery settings without identifiers', () => {
  const metrics = new HttpMetrics();
  metrics.observe('PUT', '/v1/customer/favorites/private-product', 204, 40);
  metrics.observe('GET', '/v1/customer/favorites/products?addressId=private-address', 200, 120);
  metrics.observe('GET', '/v1/customer/catalog/home?addressId=private-address', 200, 150);
  metrics.observe('GET', '/v1/customer/catalog/categories/private-category/products', 200, 140);
  metrics.observe('GET', '/v1/customer/catalog/preview', 200, 200);
  metrics.observe('GET', '/v1/customer/delivery-settings', 200, 30);
  metrics.observe('GET', '/v1/customer/search?q=private-query', 200, 160);

  const output = metrics.render();
  expect(output).toContain('route="favorites"');
  expect(output).toContain('route="catalog_home"');
  expect(output).toContain('route="catalog_category"');
  expect(output).toContain('route="catalog_preview"');
  expect(output).toContain('route="delivery_settings"');
  expect(output).toContain('route="catalog"');
  for (const secret of ['private-product', 'private-address', 'private-category', 'private-query'])
    expect(output).not.toContain(secret);
});

test('captures cart write stages and bounded idempotency outcomes', () => {
  const metrics = new HttpMetrics();
  metrics.observeStage('cart_write', 900);
  metrics.observeStage('cart_write_txn', 800);
  metrics.observeStage('cart_lock_wait', 120);
  metrics.observeStage('idempotency_claim', 300);
  metrics.observeStage('checkout_quote_txn', 700);
  metrics.observeOutcome('claimed');
  metrics.observeOutcome('replay');
  metrics.observeOutcome('in_progress');
  metrics.observeOutcome('conflict');
  metrics.observeOutcome('response_expired');
  metrics.observeOutcome('private-outcome' as never);

  const output = metrics.render();
  for (const stage of [
    'cart_write',
    'cart_write_txn',
    'cart_lock_wait',
    'idempotency_claim',
    'checkout_quote_txn',
  ])
    expect(output).toContain(
      `delivery_dependency_stage_duration_seconds_count{stage="${stage}"} 1`,
    );
  for (const outcome of ['claimed', 'replay', 'in_progress', 'conflict', 'response_expired'])
    expect(output).toContain(`delivery_idempotency_outcomes_total{outcome="${outcome}"} 1`);
  expect(output).not.toContain('private-outcome');
});

test('labels portal routes without identifiers and captures redis/session/transaction stages', () => {
  const metrics = new HttpMetrics();
  metrics.observe('GET', '/v1/rider/tasks/private-task', 200, 120);
  metrics.observe('POST', '/v1/rider/offers/private-offer/accept', 200, 200);
  metrics.observe('GET', '/v1/rider/onboarding', 200, 90);
  metrics.observe('POST', '/v1/store/auth/login?email=private@example.com', 401, 60);
  metrics.observe('GET', '/v1/store/pick-tasks/private-pick', 200, 80);
  metrics.observe('GET', '/v1/admin/catalog/products/private-product', 200, 110);
  metrics.observe('POST', '/v1/customer/webhooks/payments/razorpay', 200, 45);
  metrics.observeStage('redis', 25);
  metrics.observeStage('session_auth', 35);
  metrics.observeStage('db_transaction', 140);
  metrics.observeTransactionOutcome('committed');
  metrics.observeTransactionOutcome('retry');
  metrics.observeTransactionOutcome('deadlock');
  metrics.observeTransactionOutcome('serialization');
  metrics.observeTransactionOutcome('failed');
  metrics.observeTransactionOutcome('private-outcome' as never);

  const output = metrics.render();
  expect(output).toContain(
    'delivery_portal_route_duration_seconds_count{method="GET",audience="rider",route="rider_tasks",status_class="2xx"} 1',
  );
  expect(output).toContain('route="rider_offers"');
  expect(output).toContain('route="rider_onboarding"');
  expect(output).toContain('route="store_auth"');
  expect(output).toContain('route="store_pick_tasks"');
  expect(output).toContain('route="admin_catalog"');
  expect(output).toContain('route="payments_webhook"');
  for (const stage of ['redis', 'session_auth', 'db_transaction'])
    expect(output).toContain(
      `delivery_dependency_stage_duration_seconds_count{stage="${stage}"} 1`,
    );
  for (const outcome of ['committed', 'retry', 'deadlock', 'serialization', 'failed'])
    expect(output).toContain(`delivery_db_transaction_outcomes_total{outcome="${outcome}"} 1`);
  for (const secret of [
    'private-task',
    'private-offer',
    'private@example.com',
    'private-pick',
    'private-product',
    'private-outcome',
  ])
    expect(output).not.toContain(secret);
});
