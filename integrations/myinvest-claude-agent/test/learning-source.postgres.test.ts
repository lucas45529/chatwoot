import { Client } from 'pg'
import { expect, it } from 'vitest'
import { buildTenantRegistry } from '../src/config.js'
import { PostgresLearningSourceResolver } from '../src/learning/source.js'
import { tenants } from './fixtures.js'

// All source rows are synthetic connection-local temporary tables. The query
// needs only messages/conversations, matching the deployed read-only grants.
it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('rejects consumed drafts and cross-inbox/bot sources in real PostgreSQL', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query('CREATE TEMP TABLE conversations (id bigint, account_id bigint, display_id bigint, inbox_id bigint)')
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint, conversation_id bigint, inbox_id bigint,
      message_type integer, private boolean, sender_type text, sender_id bigint, content text, content_attributes json)`)
    await client.query('INSERT INTO conversations VALUES (700, 101, 77, 17)')
    await client.query(`INSERT INTO messages VALUES
      (55, 101, 700, 17, 0, false, 'Contact', 900, 'Wie bearbeite ich Kontakte?', '{}'),
      (61, 101, 700, 17, 1, true, 'AgentBot', 801, E'KI-Entwurf\n\nAntwortvorschlag:\nÖffne Kontakte und wähle Bearbeiten.\nQuellen: Hilfe', '{"myinvest_agent_delivery_id":"55","myinvest_agent_message_kind":"draft_note"}')`)
    const resolver = new PostgresLearningSourceResolver({ query: (sql, values) => client.query(sql, [...values]) }, buildTenantRegistry(tenants.map((tenant, index) => ({ ...tenant, agentBotId: 801 + index }))))
    const source = { accountId: 101, conversationId: 77, questionMessageId: 55, draftMessageId: 61 }
    await expect(resolver.resolve(source)).resolves.toMatchObject({ tenant: 'saas', question: 'Wie bearbeite ich Kontakte?' })
    // A bot-authored note in a historical inbox must not become fresh
    // composer provenance even when all record-level joins match.
    await client.query('UPDATE conversations SET inbox_id = 99')
    await client.query('UPDATE messages SET inbox_id = 99')
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
    await client.query('UPDATE conversations SET inbox_id = 17')
    await client.query('UPDATE messages SET inbox_id = 17')
    await client.query("INSERT INTO messages VALUES (57, 101, 700, 17, 1, false, 'User', 901, 'Gesendet vor der verzögerten privaten Notiz.', '{}')")
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
    await client.query('DELETE FROM messages WHERE id = 57')
    await client.query("INSERT INTO messages VALUES (59, 101, 700, 17, 0, false, 'Contact', 900, 'Eine neue Kundenfrage.', '{}')")
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
    await client.query('DELETE FROM messages WHERE id = 59')
    await client.query("UPDATE messages SET inbox_id = 18 WHERE id = 61")
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
    await client.query("UPDATE messages SET inbox_id = 17, sender_id = 802 WHERE id = 61")
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
    await client.query("UPDATE messages SET sender_id = 801 WHERE id = 61")
    await client.query(`INSERT INTO messages VALUES
      (62, 101, 700, 17, 1, false, 'User', 901, 'Antwort zu Kontakten.', '{}'),
      (63, 101, 700, 17, 0, false, 'Contact', 900, 'Wo finde ich die Rechnung?', '{}'),
      (64, 101, 700, 17, 1, true, 'AgentBot', 801, E'Vorschlag zur Referenz:\nDie Rechnung findest du im Konto.', '{"myinvest_agent_delivery_id":"63","myinvest_agent_message_kind":"draft_note"}')`)
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
    await expect(resolver.resolve({ ...source, questionMessageId: 63, draftMessageId: 64 })).rejects.toMatchObject({ status: 422 })
  } finally {
    await client.end()
  }
})
