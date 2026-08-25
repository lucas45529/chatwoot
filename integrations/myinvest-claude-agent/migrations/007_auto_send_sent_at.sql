-- Trennt einen geschriebenen Audit-Versuch von einer durch Chatwoot
-- bestaetigten Kundennachricht. Bestehende Zeilen bleiben bewusst NULL.
ALTER TABLE agent_auto_send_log
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_auto_send_log_sent_feedback_pending_idx
  ON agent_auto_send_log (sent_at)
  WHERE sent_at IS NOT NULL AND feedback_recorded_at IS NULL;
