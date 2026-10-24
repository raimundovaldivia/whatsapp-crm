-- The existing message is also the durable outbox entry; no second chat log.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS outbound_queue JSONB;
CREATE INDEX IF NOT EXISTS idx_messages_outbound_queue
  ON messages ((outbound_queue->>'state'), id)
  WHERE outbound_queue IS NOT NULL;
