import { Client } from 'pg'
import { expect, it } from 'vitest'
import { PostgresChatwootDeliveryStore } from '../src/chatwoot-delivery-repository.js'
import { PSEUDONYMIZATION_KEY } from './fixtures.js'

// Audit #189 (pseudonymisiert): Die Website markiert die Terminpruefung mit
// needs_human und einer privaten mip:note-Notiz. Ein folgender "." gehoert
// dem Team, bis ein Mensch oeffentlich antwortet.
it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('liest eine offene Website-Terminpruefung aus echtem PostgreSQL', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL }); await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE conversations (id bigint, display_id bigint, account_id bigint, inbox_id bigint, contact_id bigint, cached_label_list text, custom_attributes jsonb)`)
    await client.query(`CREATE TEMP TABLE contacts (id bigint, account_id bigint, email text, name text, phone_number text)`)
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint DEFAULT 1, conversation_id bigint DEFAULT 900, inbox_id bigint DEFAULT 1, sender_id bigint DEFAULT 4242, sender_type text DEFAULT 'Contact', created_at timestamptz DEFAULT '2026-10-04 14:01Z', private boolean DEFAULT false, message_type integer DEFAULT 0, content text DEFAULT '.', processed_message_content text, content_attributes json DEFAULT '{"myinvest_tenant":"new_academy","myinvest_agent_action":"draft"}', additional_attributes jsonb DEFAULT '{}', content_type integer DEFAULT 0, status integer DEFAULT 1, source_id text)`)
    await client.query(`INSERT INTO conversations VALUES (900,189,1,1,4242,'','{"myinvest_tenant":"new_academy","myinvest_channel":"whatsapp","myinvest_support_state":"needs_human"}')`)
    await client.query(`INSERT INTO contacts VALUES (4242,1,NULL,NULL,NULL)`)
    // Kundenkorrektur (vorverarbeitet), Website-Notiz, automatische Eingangsbestaetigung, dann der Punkt.
    await client.query(`INSERT INTO messages (id,created_at,content,content_attributes) VALUES (1641,'2026-10-04 14:01:25Z','Um 13:30 Uhr kann ich nicht, deswegen habe ich den Termin um 17:45 Uhr gebucht','{"myinvest_tenant":"new_academy","myinvest_agent_action":"preprocessed"}')`)
    await client.query(`INSERT INTO messages (id,sender_type,sender_id,message_type,private,created_at,content,source_id,content_attributes) VALUES (1643,'User',1,1,true,'2026-10-04 14:01:30Z','Der Kunde meldet eine bereits erfolgte Terminänderung.','mip:note:new_academy:termin-review:abc','{"myinvest_agent_action":"preprocessed","myinvest_note_id":"termin-review:abc"}')`)
    await client.query(`INSERT INTO messages (id,sender_type,sender_id,message_type,private,created_at,content,source_id,content_attributes) VALUES (1644,'User',1,1,false,'2026-10-04 14:01:31Z','Danke dir für den Hinweis zu deiner Buchung.','mip:wa:new_academy:out:abc','{"myinvest_agent_action":"preprocessed","myinvest_outbound_kind":"reply_termin_antwort","myinvest_outbound_id":"x"}')`)
    await client.query(`INSERT INTO messages (id,created_at) VALUES (1645,'2026-10-04 14:01:41Z')`)
    const store = new PostgresChatwootDeliveryStore({ query: (sql, values) => client.query(sql, values ? [...values] : []) }, PSEUDONYMIZATION_KEY)
    const input = { accountId: 1, inboxId: 1, conversationDisplayId: 189, currentMessageId: 1645 }
    const open = async () => (await store.loadContext(input))?.websiteReviewOpen === true

    // Die automatische Eingangsbestaetigung ist keine Menschenantwort.
    expect(await open()).toBe(true)
    for (const mutation of [
      `UPDATE conversations SET custom_attributes = custom_attributes - 'myinvest_support_state'`,
      `UPDATE conversations SET custom_attributes = jsonb_set(custom_attributes, '{myinvest_support_state}', '"rebooking_done"')`,
      `UPDATE messages SET source_id = 'other:note' WHERE id = 1643`,
      `UPDATE messages SET private = false WHERE id = 1643`,
      `UPDATE messages SET conversation_id = 901 WHERE id = 1643`,
      // Ein Mensch hat nach der Notiz oeffentlich geantwortet: Fall ist bearbeitet.
      `INSERT INTO messages (id,sender_type,sender_id,message_type,private,created_at,content,content_attributes) VALUES (1650,'User',4,1,false,'2026-10-04 15:00Z','Dein Termin um 17:45 Uhr steht.','{}')`,
    ]) {
      await client.query('BEGIN')
      await client.query(mutation)
      expect(await open(), mutation).toBe(false)
      await client.query('ROLLBACK')
    }
  } finally { await client.end() }
})
