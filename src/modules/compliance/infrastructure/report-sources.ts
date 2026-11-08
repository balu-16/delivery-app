/** Static SQL only. Common columns permit bounded, scope-bound keyset pages. No contact or message text is exported. */
export const REPORT_SOURCES = {
  catalog: `SELECT i.store_id::text||':'||v.id::text AS row_key,i.store_id,v.created_at AS event_at,
    v.id AS variant_id,v.product_id,v.sku,v.name,p.published,v.deleted_at IS NULL AND p.deleted_at IS NULL AS active,
    price.selling_paise::text AS selling_paise,price.mrp_paise::text AS mrp_paise
    FROM store_inventory i JOIN catalog_variants v ON v.id=i.variant_id JOIN catalog_products p ON p.id=v.product_id
    LEFT JOIN LATERAL (SELECT selling_paise,mrp_paise FROM catalog_prices cp WHERE cp.store_id=i.store_id AND cp.variant_id=v.id
      AND cp.valid_from<=transaction_timestamp() AND (cp.valid_to IS NULL OR cp.valid_to>transaction_timestamp()) ORDER BY valid_from DESC LIMIT 1) price ON true`,
  stock: `SELECT i.store_id::text||':'||i.variant_id::text AS row_key,i.store_id,NULL::timestamptz AS event_at,
    i.variant_id,i.on_hand::text,i.reserved::text,COALESCE(a.available,0)::text AS available,i.version::text
    FROM store_inventory i LEFT JOIN LATERAL (
      SELECT COALESCE(sum(b.on_hand-b.reserved),0)::bigint AS available FROM inventory_batches b
      JOIN catalog_variants v ON v.id=b.variant_id JOIN catalog_products p ON p.id=v.product_id
      LEFT JOIN inventory_category_shelf_life shelf ON shelf.category_id=p.category_id
      WHERE b.store_id=i.store_id AND b.variant_id=i.variant_id AND b.state='ACTIVE'
      AND (b.expires_at IS NULL OR b.expires_at>transaction_timestamp()+COALESCE(shelf.min_seconds,0)*interval '1 second')
    ) a ON true`,
  financial: `SELECT 'document:'||d.id::text AS row_key,o.store_id,d.issued_at AS event_at,
    d.kind AS activity,d.id::text AS reference_id,d.order_id,o.currency,
    (CASE WHEN d.kind='CREDIT_NOTE' THEN -1 ELSE 1 END * (d.payload->>'totalPaise')::bigint)::text AS amount_paise,d.status AS state
    FROM invoice_documents d JOIN orders o ON o.id=d.order_id WHERE d.status='ISSUED'
    UNION ALL SELECT 'capture:'||c.id::text,o.store_id,c.created_at,
    CASE WHEN a.kind='WALLET_TOPUP' THEN 'WALLET_TOPUP_CAPTURE' WHEN o.metadata->>'fundingPaymentId'=c.gateway_payment_id THEN 'ORDER_CAPTURE' ELSE 'UNAPPLIED_ORDER_CAPTURE' END,
    c.gateway_payment_id,c.order_id,c.currency,c.amount_paise::text,a.status
    FROM payment_capture_receipts c JOIN payment_attempts a ON a.id=c.attempt_id LEFT JOIN orders o ON o.id=c.order_id
    UNION ALL SELECT 'wallet:'||w.id::text,o.store_id,w.created_at,'ORDER_WALLET_SPEND',w.id::text,o.id,o.currency,(-w.delta_paise)::text,'SETTLED'
    FROM wallet_ledger w JOIN orders o ON w.ref_id=o.id::text WHERE w.reason='ORDER_PAYMENT'
    UNION ALL SELECT 'refund:'||r.id::text,o.store_id,CASE WHEN r.status='PROCESSED' THEN r.updated_at ELSE r.created_at END,
    'REFUND_'||r.source_type,r.id::text,r.order_id,o.currency,(-r.amount_paise)::text,r.status
    FROM payment_refunds r JOIN orders o ON o.id=r.order_id
    UNION ALL SELECT 'cod:'||c.id::text,o.store_id,c.collected_at,'COD_COLLECTION',c.id::text,c.order_id,c.currency,c.amount_paise::text,c.state
    FROM cod_collections c JOIN orders o ON o.id=c.order_id WHERE c.state='COLLECTED'`,
  picking: `SELECT t.id::text AS row_key,t.store_id,COALESCE(t.completed_at,t.created_at) AS event_at,t.id AS task_id,t.order_id,t.status,
    COALESCE(sum(i.expected_qty),0)::text AS ordered_units,COALESCE(sum(i.picked_qty),0)::text AS picked_units,
    COALESCE(sum(CASE WHEN i.status='SHORT' THEN i.expected_qty-i.picked_qty ELSE 0 END),0)::text AS short_units,
    t.completed_at,t.sla_due_at FROM pick_tasks t LEFT JOIN pick_items i ON i.task_id=t.id GROUP BY t.id`,
  rider: `SELECT 'earning:'||e.id::text AS row_key,o.store_id,e.computed_at AS event_at,e.rider_id,'EARNING'::text AS activity,e.id::text AS reference_id,e.total_paise::text AS amount_paise,NULL::text AS due_after_paise,
    CASE WHEN e.payout_reference IS NULL THEN 'UNALLOCATED' ELSE 'ALLOCATED' END AS state
    FROM rider_earnings e JOIN orders o ON o.id=e.order_id
    UNION ALL SELECT 'cash:'||l.id::text,s.store_id,l.created_at,l.rider_id,
    CASE WHEN l.ref_type='payout_offset' THEN 'PAYOUT_OFFSET' ELSE l.reason END,l.id::text,l.delta_paise::text,l.balance_after::text,'SETTLED'
    FROM rider_cash_ledger l LEFT JOIN cod_settlements s ON l.ref_type='cod_settlement' AND l.ref_id=s.id::text
    UNION ALL SELECT 'payout:'||p.id::text,NULL::uuid,COALESCE(p.paid_at,p.approved_at,p.created_at),p.rider_id,'PAYOUT',p.id::text,p.net_paise::text,NULL::text,p.state FROM rider_payouts p
    UNION ALL SELECT 'correction:'||c.id::text,NULL::uuid,COALESCE(c.settled_at,c.created_at),p.rider_id,'PAYOUT_CORRECTION',c.id::text,c.delta_paise::text,NULL::text,c.state FROM payout_corrections c JOIN rider_payouts p ON p.id=c.payout_id`,
  subscription: `SELECT 'occurrence:'||o.id::text AS row_key,s.store_id,(o.delivery_date::timestamp AT TIME ZONE 'Asia/Kolkata') AS event_at,
    s.id AS subscription_id,o.delivery_date::text,o.state,o.reason,s.status AS subscription_status,o.order_id,o.fulfillment_outcome,
    ord.total_paise::text AS amount_paise FROM subscription_occurrences o JOIN subscriptions s ON s.id=o.subscription_id LEFT JOIN orders ord ON ord.id=o.order_id`,
  support: `SELECT t.id::text AS row_key,o.store_id,t.created_at AS event_at,t.id AS ticket_id,t.category,t.status,t.assignee_id,t.order_id,
    t.first_response_due_at,t.first_response_at,t.resolution_due_at,t.resolved_at,t.closed_at,
    EXISTS(SELECT 1 FROM support_sla_alerts a WHERE a.ticket_id=t.id) AS breached
    FROM support_tickets t LEFT JOIN orders o ON o.id=t.order_id`,
} as const;
