import { Client } from 'pg'
import { expect, it } from 'vitest'
import { loadConversationHistory } from '../src/conversation-history.js'

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('proves chronological public delivered history isolation in PostgreSQL', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE conversations (id bigint, account_id bigint, inbox_id bigint, custom_attributes jsonb)`)
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint DEFAULT 1, conversation_id bigint DEFAULT 3,
      inbox_id bigint DEFAULT 2, created_at timestamptz DEFAULT '2026-09-19 10:00Z', message_type integer DEFAULT 1,
      sender_type text, content text, processed_message_content text, content_attributes json DEFAULT '{}',
      additional_attributes jsonb DEFAULT '{}', private boolean DEFAULT false, content_type integer DEFAULT 0,
      status integer DEFAULT 1, source_id text)`)
    await client.query(`INSERT INTO conversations VALUES (3, 1, 2, '{"myinvest_tenant":"saas"}')`)
    await client.query(`INSERT INTO messages (id, content, sender_type, message_type) VALUES
      (50, 'Danke!', 'Contact', 0), (10, 'Termin am 19.09.2026 bestätigt.', NULL, 1),
      (20, 'Privater Entwurf', 'AgentBot', 1), (21, 'Fehlgeschlagene Buchung', NULL, 1),
      (22, 'Ausstehender Versand', NULL, 1), (23, 'Fremder Mandant', NULL, 1),
      (24, 'Fremder Account', NULL, 1), (25, 'Fremde Inbox', NULL, 1),
      (26, 'Fremde Unterhaltung', NULL, 1), (27, 'Zukünftiger Inhalt', NULL, 1),
      (51, 'Später bei gleicher Zeit', NULL, 1), (52, 'Früher trotz höherer ID', 'Contact', 0),
      (30, NULL, NULL, 3)`)
    await client.query(`UPDATE messages SET private = true WHERE id = 20`)
    await client.query(`UPDATE messages SET status = 3 WHERE id = 21`)
    await client.query(`UPDATE messages SET status = 0 WHERE id = 22`)
    await client.query(`UPDATE messages SET content_attributes = '{"myinvest_tenant":"legacy_academy"}' WHERE id = 23`)
    await client.query(`UPDATE messages SET account_id = 8 WHERE id = 24`)
    await client.query(`UPDATE messages SET inbox_id = 8 WHERE id = 25`)
    await client.query(`UPDATE messages SET conversation_id = 8 WHERE id = 26`)
    await client.query(`UPDATE messages SET created_at = '2026-09-19 10:01Z' WHERE id = 27`)
    await client.query(`UPDATE messages SET created_at = '2026-09-19 09:59Z' WHERE id = 52`)
    await client.query(`UPDATE messages SET content_attributes = '{"automation_rule_id":1}' WHERE id = 10`)
    await client.query(`UPDATE messages SET processed_message_content = 'Zoom: https://zoom.us/j/123456789', additional_attributes = '{"campaign_id":1}' WHERE id = 30`)
    const history = await loadConversationHistory({ query: (sql, values) => client.query(sql, [...values]) }, { accountId: 1, inboxId: 2, conversationId: '3', currentMessageId: 50 })
    expect(history).toEqual([
      { role: 'customer', text: 'Früher trotz höherer ID' },
      { role: 'assistant', text: '[Automatische Nachricht] Termin am 19.09.2026 bestätigt.' },
      { role: 'assistant', text: '[Kampagnennachricht] Zoom: [ZOOM-LINK]' },
    ])
  } finally { await client.end() }
})
