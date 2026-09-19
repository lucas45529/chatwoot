import { Client } from 'pg'
import { expect, it } from 'vitest'
import { PostgresChatwootDeliveryStore } from '../src/chatwoot-delivery-repository.js'
import { PSEUDONYMIZATION_KEY } from './fixtures.js'

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('binds ongoing document routing to recent private bot evidence and its original customer source', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL }); await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE conversations (id bigint, display_id bigint, account_id bigint, inbox_id bigint, contact_id bigint, cached_label_list text, custom_attributes jsonb)`)
    await client.query(`CREATE TEMP TABLE contacts (id bigint, account_id bigint, email text, name text, phone_number text)`)
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint DEFAULT 101, conversation_id bigint DEFAULT 900, inbox_id bigint DEFAULT 17, sender_id bigint DEFAULT 4242, sender_type text DEFAULT 'Contact', created_at timestamptz DEFAULT '2026-09-19 12:00Z', private boolean DEFAULT false, message_type integer DEFAULT 0, content text DEFAULT 'Welche Rechnung ist offen?', processed_message_content text, content_attributes json DEFAULT '{"myinvest_tenant":"saas"}', additional_attributes jsonb DEFAULT '{}', content_type integer DEFAULT 0, status integer DEFAULT 1, source_id text)`)
    await client.query(`INSERT INTO conversations VALUES (900,77,101,17,4242,'','{"myinvest_tenant":"saas","myinvest_channel":"whatsapp"}')`)
    await client.query(`INSERT INTO contacts VALUES (4242,101,NULL,NULL,NULL)`)
    await client.query(`INSERT INTO messages (id,created_at,content) VALUES (50,'2026-09-19 11:00Z','Bitte meine Rechnung.'),(55,'2026-09-19 12:00Z','Welche Rechnung ist offen?')`)
    await client.query(`INSERT INTO messages (id,sender_type,sender_id,message_type,private,created_at,content_attributes) VALUES (51,'AgentBot',9,1,true,'2026-09-19 11:01Z','{"myinvest_agent_message_kind":"document_assistance_note","myinvest_agent_delivery_id":"50"}')`)
    const store = new PostgresChatwootDeliveryStore({ query: (sql, values) => client.query(sql, values ? [...values] : []) }, PSEUDONYMIZATION_KEY)
    const input = { accountId: 101, inboxId: 17, conversationDisplayId: 77, currentMessageId: 55 }
    const active = async () => (await store.loadContext(input))?.documentAssistanceActive === true
    expect(await active()).toBe(true)
    for (const mutation of ["private=false", "sender_type='User'", 'account_id=202', 'inbox_id=18', 'conversation_id=901', "created_at='2026-09-18 10:00Z'", "created_at='2026-09-19 12:01Z'", `content_attributes='{"myinvest_agent_message_kind":"document_assistance_note","myinvest_agent_delivery_id":"99"}'`]) {
      await client.query('BEGIN')
      await client.query(`UPDATE messages SET ${mutation} WHERE id=51`)
      expect(await active(), mutation).toBe(false)
      await client.query('ROLLBACK')
    }
    for (const mutation of ['sender_id=999', 'account_id=202', 'inbox_id=18', 'conversation_id=901', 'private=true', 'message_type=1', "content_attributes='{\"myinvest_tenant\":\"new_academy\"}'"]) {
      await client.query('BEGIN')
      await client.query(`UPDATE messages SET ${mutation} WHERE id=50`)
      expect(await active(), mutation).toBe(false)
      await client.query('ROLLBACK')
    }
  } finally { await client.end() }
})
