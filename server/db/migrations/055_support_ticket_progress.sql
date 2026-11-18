-- Up Migration
-- Progress records do not contain ticket text or other customer content.
CREATE TABLE support_ticket_events (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('ACKNOWLEDGED','OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX support_ticket_events_ticket_idx ON support_ticket_events(ticket_id, created_at, id);
CREATE UNIQUE INDEX support_ticket_first_ack_idx ON support_ticket_events(ticket_id) WHERE event_type='ACKNOWLEDGED';

-- Down Migration
DROP TABLE support_ticket_events;
