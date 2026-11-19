-- Up Migration
-- Assistant cart choices (plan4): one active choice per thread with the exact
-- catalog variants, delivery context and confirmation expiry. Canned replies:
-- versioned server answers served before model admission with zero model use.
CREATE TABLE agent_cart_choices (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  variants jsonb NOT NULL,
  delivery jsonb NOT NULL DEFAULT '{}'::jsonb,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX agent_cart_choices_one_pending ON agent_cart_choices(thread_id) WHERE status = 'pending';
CREATE INDEX agent_cart_choices_owner ON agent_cart_choices(user_id, thread_id);

CREATE TABLE agent_canned_replies (
  key text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  body text NOT NULL,
  link text NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO agent_canned_replies(key, version, title, body, link) VALUES
  ('greeting_1', 1, 'Greeting', 'Hi, I''m your DairyDirect assistant. How can I help?', NULL),
  ('greeting_2', 1, 'Greeting', 'Hello! I can help with your cart and orders.', NULL),
  ('greeting_3', 1, 'Greeting', 'Welcome! What would you like to shop for today?', NULL),
  ('greeting_4', 1, 'Greeting', 'Hey! I can help you find products or track a delivery.', NULL),
  ('thanks_1', 1, 'Thanks', 'You''re welcome!', NULL),
  ('thanks_2', 1, 'Thanks', 'Happy to help!', NULL),
  ('thanks_3', 1, 'Thanks', 'Anytime — is there anything else I can do?', NULL),
  ('thanks_4', 1, 'Thanks', 'Glad I could help!', NULL),
  ('faq_cart', 1, 'Cart', 'Your cart is on the Cart tab. Quantities update as you tap plus or minus, and you can undo a change from the cart screen.', 'cart'),
  ('faq_address', 1, 'Addresses', 'You can add or confirm a delivery address from the address panel on Home. A confirmed location is needed before checkout when the store requires it.', 'addresses'),
  ('faq_tracking', 1, 'Order tracking', 'You can follow every order from the orders screen with live status updates.', 'orders'),
  ('faq_support', 1, 'Support', 'If something needs a person, raise a support ticket from the Help section and the team will respond there.', 'support'),
  ('help', 1, 'Help', 'I can help with your cart, delivery addresses, order tracking, and support. Tell me what you need — for example “add curd to my cart”.', NULL);

-- Down Migration
DROP TABLE agent_cart_choices;
DROP TABLE agent_canned_replies;
