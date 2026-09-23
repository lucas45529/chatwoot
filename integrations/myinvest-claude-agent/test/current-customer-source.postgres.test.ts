import { Client } from 'pg'
import { expect, it } from 'vitest'
import { PostgresChatwootDeliveryStore } from '../src/chatwoot-delivery-repository.js'
import { PSEUDONYMIZATION_KEY } from './fixtures.js'

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('proves live source identity and rejects newer public incoming/human messages in PostgreSQL', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL }); await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE conversations (id bigint, display_id bigint, account_id bigint, inbox_id bigint, contact_id bigint, custom_attributes jsonb)`)
    await client.query(`CREATE TEMP TABLE inboxes (id bigint, account_id bigint, channel_type text)`)
    await client.query(`CREATE TEMP TABLE contacts (id bigint, account_id bigint)`)
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint DEFAULT 101, conversation_id bigint DEFAULT 900, inbox_id bigint DEFAULT 17, sender_id bigint DEFAULT 4242, sender_type text DEFAULT 'Contact', created_at timestamptz DEFAULT '2026-08-16 18:30:44.414Z', private boolean DEFAULT false, message_type integer DEFAULT 0, content text DEFAULT 'Wie geht das?', source_id text, additional_attributes jsonb DEFAULT '{}', content_attributes json DEFAULT '{"myinvest_tenant":"saas"}')`)
    await client.query(`INSERT INTO conversations VALUES (900,77,101,17,4242,'{"myinvest_tenant":"saas"}')`)
    await client.query(`INSERT INTO inboxes VALUES (17,101,'Channel::Api')`)
    await client.query(`INSERT INTO contacts VALUES (4242,101)`)
    await client.query(`INSERT INTO messages (id) VALUES (55)`)
    const store = new PostgresChatwootDeliveryStore({ query: (sql, values) => client.query(sql, values ? [...values] : []) }, PSEUDONYMIZATION_KEY)
    const input = { accountId: 101, inboxId: 17, conversationDisplayId: 77, currentMessageId: 55, tenant: 'saas' as const, channel: 'whatsapp' as const }
    expect(await store.loadCurrentSource(input)).toEqual({ content: 'Wie geht das?', executionContext: { accountId: 101, inboxId: 17, conversationId: 77, contactId: 4242, sourceMessageId: 55, sourceChannel: 'whatsapp', sourceReceivedAt: '2026-08-16T18:30:44.414Z', mode: 'customer_message' } })
    for (const variant of [{ accountId: 202 }, { inboxId: 18 }, { conversationDisplayId: 78 }, { currentMessageId: 56 }, { tenant: 'new_academy' as const }]) expect(await store.loadCurrentSource({ ...input, ...variant })).toBeUndefined()
    for (const change of ['private=true', "sender_type='AgentBot'", 'sender_id=999', 'message_type=1']) {
      await client.query(`UPDATE messages SET ${change} WHERE id=55`)
      expect(await store.loadCurrentSource(input)).toBeUndefined()
      await client.query(`UPDATE messages SET private=false,sender_type='Contact',sender_id=4242,message_type=0 WHERE id=55`)
    }
    await client.query(`INSERT INTO messages (id) VALUES (56)`)
    expect(await store.loadCurrentSource(input)).toBeUndefined()
    await client.query(`UPDATE messages SET message_type=1,sender_type='User' WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeUndefined()
    await client.query(`UPDATE messages SET source_id='mip:wa:saas:out:termin-antwort:56',content_attributes='{"myinvest_outbound_id":"receipt-56","myinvest_outbound_kind":"appointment_review_ack"}' WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeDefined()
    await client.query(`UPDATE messages SET content_attributes='{}' WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeUndefined()
    await client.query(`UPDATE messages SET source_id='mip:history:saas:56',content_attributes='{}' WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeUndefined()
    await client.query(`UPDATE messages SET content_attributes='{"myinvest_history_author":"bot"}' WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeDefined()
    await client.query(`UPDATE messages SET source_id=NULL,content_attributes='{}' WHERE id=56`)
    await client.query(`UPDATE messages SET private=true WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeDefined()
    await client.query(`UPDATE messages SET private=false,account_id=202 WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeDefined()
    await client.query(`UPDATE messages SET account_id=101,created_at='2026-08-16 18:30:43Z' WHERE id=56`)
    expect(await store.loadCurrentSource(input)).toBeDefined()
    await client.query(`UPDATE conversations SET custom_attributes='{"myinvest_tenant":"saas","myinvest_channel":"web"}'`)
    expect(await store.loadCurrentSource(input)).toBeUndefined()
    await client.query(`UPDATE conversations SET custom_attributes='{"myinvest_tenant":"saas","myinvest_channel":"whatsapp"}'`)
    expect(await store.loadCurrentSource(input)).toBeDefined()
    await client.query(`UPDATE inboxes SET channel_type='Channel::Email' WHERE id=17`)
    expect((await store.loadCurrentSource(input))?.executionContext.sourceChannel).toBe('email')
  } finally { await client.end() }
})
