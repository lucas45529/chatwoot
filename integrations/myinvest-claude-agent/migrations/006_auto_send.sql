CREATE TABLE IF NOT EXISTS agent_auto_send_log (
  id bigserial PRIMARY KEY,
  tenant_key text NOT NULL CHECK (tenant_key IN ('saas', 'new_academy', 'legacy_academy')),
  conversation_id bigint NOT NULL CHECK (conversation_id > 0),
  -- Chatwoot-Nachricht, die beantwortet wurde: Idempotenzschluessel je Mandant.
  message_id bigint NOT NULL CHECK (message_id > 0),
  -- Pseudonym des Kontakts (Hash), nie eine Kontaktangabe im Klartext.
  contact_hash text,
  question_hash text NOT NULL,
  confidence numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_ids text[] NOT NULL DEFAULT '{}',
  sent_text text NOT NULL,
  feedback_rating text CHECK (feedback_rating IN ('helpful', 'unhelpful', 'human_correction', 'none')),
  feedback_recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, message_id)
);

CREATE INDEX IF NOT EXISTS agent_auto_send_log_conversation_idx
  ON agent_auto_send_log (tenant_key, conversation_id);

CREATE INDEX IF NOT EXISTS agent_auto_send_log_contact_window_idx
  ON agent_auto_send_log (tenant_key, contact_hash, created_at)
  WHERE contact_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_auto_send_log_feedback_pending_idx
  ON agent_auto_send_log (created_at)
  WHERE feedback_recorded_at IS NULL;

-- Sobald ein Mensch in einer Konversation geschrieben hat, ist Auto-Send dort
-- dauerhaft aus. Der Verlaufsblick reicht nur 12 Nachrichten und 30 Tage weit;
-- diese Zeile ueberlebt beides.
CREATE TABLE IF NOT EXISTS agent_auto_send_blocks (
  tenant_key text NOT NULL CHECK (tenant_key IN ('saas', 'new_academy', 'legacy_academy')),
  conversation_id bigint NOT NULL CHECK (conversation_id > 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, conversation_id)
);
