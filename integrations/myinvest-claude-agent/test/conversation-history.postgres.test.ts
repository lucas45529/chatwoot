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

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('retains customer evidence400/402 before836 without private, foreign or future anchors', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE conversations (id bigint, account_id bigint, inbox_id bigint, custom_attributes jsonb)`)
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint DEFAULT 1, conversation_id bigint DEFAULT 16,
      inbox_id bigint DEFAULT 2, created_at timestamptz DEFAULT '2026-09-01 10:00Z', message_type integer DEFAULT 0,
      sender_type text DEFAULT 'Contact', content text, processed_message_content text, content_attributes json DEFAULT '{"myinvest_tenant":"new_academy"}',
      additional_attributes jsonb DEFAULT '{}', private boolean DEFAULT false, content_type integer DEFAULT 0,
      status integer DEFAULT 1, source_id text)`)
    await client.query(`INSERT INTO conversations VALUES (16,1,2,'{"myinvest_tenant":"new_academy","myinvest_channel":"whatsapp"}')`)
    await client.query(`INSERT INTO messages (id,content) VALUES
      (352,'Bitte den ersten Kontakt ohne Interesse ersetzen.'),
      (354,'Wie heißt der Kunde ohne Interesse?'),
      (355,'Fremde Bezugsfrage'), (356,'Private Bezugsfrage'),
      (400,'Erster Lead: alpha@example.test'), (402,'Zweiter Lead: beta@example.test; nur Anrufbeantworter.'),
      (450,'Privater KI-Vorschlag: private@example.test'), (451,'Interne Mitarbeiternotiz: internal@example.test'),
      (452,'Anderes Produkt: tenant@example.test'), (453,'Anderer Account: account@example.test'),
      (454,'Andere Inbox: inbox@example.test'), (455,'Anderes Gespräch: other@example.test'),
      (456,'Zukünftiger Kontakt: future@example.test'), (457,'Leere Bildnachricht'),
      (458,'Öffentliche KI-Behauptung: bot@example.test'),
      (830,'Korrektur: Den ersten Kontakt bitte nicht mehr verwenden, ausschließlich corrected@example.test.'),
      (836,'Ich habe die Kontaktdaten schon genannt.'), (837,'Privater KI-Entwurf fragt erneut nach Kontakt: draft@example.test')`)
    await client.query(`UPDATE messages SET message_type=1, sender_type='User' WHERE id IN (354,355,356)`)
    await client.query(`UPDATE messages SET content_attributes='{"myinvest_tenant":"saas"}' WHERE id=355`)
    await client.query(`UPDATE messages SET private=true WHERE id=356`)
    await client.query(`UPDATE messages SET private=true, message_type=1, sender_type='AgentBot' WHERE id IN (450,837)`)
    await client.query(`UPDATE messages SET private=true, message_type=1, sender_type='User' WHERE id=451`)
    await client.query(`UPDATE messages SET content_attributes='{"myinvest_tenant":"saas"}' WHERE id=452`)
    await client.query(`UPDATE messages SET account_id=8 WHERE id=453`)
    await client.query(`UPDATE messages SET inbox_id=8 WHERE id=454`)
    await client.query(`UPDATE messages SET conversation_id=8 WHERE id=455`)
    await client.query(`UPDATE messages SET created_at='2026-09-20 10:00Z' WHERE id=456`)
    await client.query(`UPDATE messages SET content=NULL, content_type=1 WHERE id=457`)
    await client.query(`UPDATE messages SET message_type=1,sender_type='AgentBot' WHERE id=458`)
    await client.query(`INSERT INTO messages (id,content) SELECT n, 'Weitere Rückfrage ' || n FROM generate_series(600,619) n`)
    const read = () => loadConversationHistory({ query: (sql, values) => client.query(sql, [...values]) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    const history = await read()
    expect(history).toHaveLength(12)
    expect(history[0]?.text).toContain('#354 · 2026-09-01T10:00:00.000Z · Mitarbeiter:')
    expect(history[0]?.text).toContain('Wie heißt der Kunde ohne Interesse?')
    expect(history[0]?.text).not.toMatch(/#35[56]/)
    expect(history[0]?.text).toContain('#400 · 2026-09-01T10:00:00.000Z')
    expect(history[0]?.text).toContain('#402 · 2026-09-01T10:00:00.000Z')
    expect(history[0]?.text).not.toMatch(/#45[0-8]|#837|private|internal|tenant|account|inbox|other|future|bot|draft/)
    expect(history[0]?.text).toContain('[E-MAIL/ACCOUNT]')
    expect(history.at(-1)?.text).toContain('Den ersten Kontakt bitte nicht mehr verwenden')
    expect(history.map(t => t.text).join('\n')).not.toContain('@example.test')
    // A hard100-row scan bound prevents an ever-growing per-conversation read.
    await client.query(`INSERT INTO messages (id,content) SELECT n, 'Begrenzter weiterer Verlauf ' || n FROM generate_series(700,799) n`)
    const bounded = await read()
    expect(bounded).toHaveLength(12)
    expect(bounded.some(t => t.text.includes('#400'))).toBe(false)
  } finally { await client.end() }
})
