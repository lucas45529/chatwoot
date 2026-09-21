import { Client } from 'pg'
import { expect, it } from 'vitest'
import { buildTenantRegistry } from '../src/config.js'
import {
  discoverAutomaticLearningSources,
  resolveAutomaticLearningSource,
} from '../src/learning/automatic-source.js'
import { tenants } from './fixtures.js'

const registry = buildTenantRegistry(
  tenants.map((tenant, index) => ({ ...tenant, agentBotId: 801 + index })),
)
const now = new Date('2026-09-21T10:00:00.000Z')

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)(
  'proves exact question-draft-human correction provenance in PostgreSQL',
  async () => {
    const client = new Client({
      connectionString: process.env.LEARNING_TEST_DATABASE_URL,
    })
    await client.connect()
    try {
      await client.query(`CREATE TEMP TABLE conversations (
        id bigint, account_id bigint, display_id bigint, inbox_id bigint,
        contact_id bigint, custom_attributes jsonb)`)
      await client.query(`CREATE TEMP TABLE messages (
        id bigint, account_id bigint, conversation_id bigint, inbox_id bigint,
        message_type integer, private boolean, sender_type text, sender_id bigint,
        content text, processed_message_content text, content_attributes json,
        additional_attributes jsonb DEFAULT '{}', created_at timestamptz,
        content_type integer DEFAULT 0, status integer, source_id text)`)
      await client.query(
        `INSERT INTO conversations VALUES
          (700, 101, 77, 17, 900, '{"myinvest_tenant":"saas","myinvest_channel":"web"}')`,
      )
      await client.query(`INSERT INTO messages
        (id,account_id,conversation_id,inbox_id,message_type,private,sender_type,sender_id,content,content_attributes,created_at,status,source_id)
        VALUES
        (50,101,700,17,1,false,'User',901,'Frühere öffentliche Hilfe','{}','2026-09-20 09:59Z',1,'external-50'),
        (55,101,700,17,0,false,'Contact',900,'Wie bearbeite ich Kontakte?','{"myinvest_tenant":"saas"}','2026-09-20 10:00Z',1,NULL),
        (61,101,700,17,1,true,'AgentBot',801,E'KI-Entwurf\\n\\nAntwortvorschlag:\\nÖffne Kontakte und wähle Bearbeiten.\\nQuellen: Hilfe','{"myinvest_agent_delivery_id":"55","myinvest_agent_message_kind":"draft_note"}','2026-09-20 10:01Z',1,NULL),
        (62,101,700,17,1,false,'User',901,'Öffne Kontakte, wähle den Eintrag und nutze Bearbeiten.','{}','2026-09-20 10:02Z',1,'external-62')`,
      )
      await client.query('BEGIN')

      const database = {
        query: <Row extends Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = [],
        ) => client.query<Row>(sql, [...values]),
      }
      const discovered = await discoverAutomaticLearningSources(
        database,
        registry,
        { tenant: 'saas', now },
      )
      expect(discovered.sources).toHaveLength(1)
      expect(discovered.sources[0]).toMatchObject({
        source: {
          accountId: 101,
          inboxId: 17,
          conversationId: 77,
          questionMessageId: 55,
          draftMessageId: 61,
          answerMessageId: 62,
        },
        history: [{ role: 'agent', text: 'Frühere öffentliche Hilfe' }],
      })
      await expect(
        resolveAutomaticLearningSource(database, registry, {
          source: discovered.sources[0]!.source,
          contentHash: discovered.sources[0]!.contentHash,
        }),
      ).resolves.toEqual(discovered.sources[0])

      await client.query('SAVEPOINT automatic_history_case')
      await client.query(
        `UPDATE messages SET content='Nachträglich geänderter Verlauf' WHERE id=50`,
      )
      await expect(
        resolveAutomaticLearningSource(database, registry, {
          source: discovered.sources[0]!.source,
          contentHash: discovered.sources[0]!.contentHash,
        }),
      ).rejects.toThrow('automatic_learning_source_changed')
      await client.query('ROLLBACK TO SAVEPOINT automatic_history_case')

      await client.query('SAVEPOINT automatic_history_case')
      await client.query(`DELETE FROM messages WHERE id=50`)
      await expect(
        resolveAutomaticLearningSource(database, registry, {
          source: discovered.sources[0]!.source,
          contentHash: discovered.sources[0]!.contentHash,
        }),
      ).rejects.toThrow('automatic_learning_source_changed')
      await client.query('ROLLBACK TO SAVEPOINT automatic_history_case')
      expect(
        (
          await discoverAutomaticLearningSources(database, registry, {
            tenant: 'new_academy',
            now,
          })
        ).sources,
      ).toEqual([])

      await client.query(
        `UPDATE conversations SET custom_attributes='{"myinvest_tenant":"saas","myinvest_channel":"whatsapp"}'`,
      )
      await client.query(`UPDATE messages SET status=0, source_id=NULL WHERE id=62`)
      expect(
        (
          await discoverAutomaticLearningSources(database, registry, {
            tenant: 'saas',
            now,
          })
        ).sources,
      ).toEqual([])
      await client.query(
        `UPDATE messages SET source_id='whatsapp-provider-62' WHERE id=62`,
      )
      const queued = await discoverAutomaticLearningSources(database, registry, {
        tenant: 'saas',
        now,
      })
      expect(queued.sources).toHaveLength(1)
      await client.query(`UPDATE messages SET status=1 WHERE id=62`)
      await expect(
        resolveAutomaticLearningSource(database, registry, {
          source: queued.sources[0]!.source,
          contentHash: queued.sources[0]!.contentHash,
        }),
      ).resolves.toMatchObject({ contentHash: queued.sources[0]!.contentHash })
      await client.query(`UPDATE messages SET status=3 WHERE id=62`)
      await expect(
        resolveAutomaticLearningSource(database, registry, {
          source: queued.sources[0]!.source,
          contentHash: queued.sources[0]!.contentHash,
        }),
      ).rejects.toThrow('automatic_learning_source_not_found')
      await client.query(
        `UPDATE conversations SET custom_attributes='{"myinvest_tenant":"saas","myinvest_channel":"web"}'`,
      )
      await client.query(
        `UPDATE messages SET status=1, source_id='external-62' WHERE id=62`,
      )

      const mutations = [
        `UPDATE messages SET status=NULL WHERE id=62`,
        `UPDATE messages SET status=3 WHERE id=62`,
        `UPDATE messages SET sender_type='AgentBot' WHERE id=62`,
        `UPDATE messages SET content_attributes='{"myinvest_agent_action":"preprocessed"}' WHERE id=62`,
        `UPDATE messages SET source_id='mip:echo:62' WHERE id=62`,
        `UPDATE messages SET additional_attributes='{"campaign_id":1}' WHERE id=62`,
        `UPDATE messages SET sender_id=999 WHERE id=55`,
        `UPDATE messages SET sender_id=802 WHERE id=61`,
        `UPDATE messages SET content_attributes='{"myinvest_agent_delivery_id":"99","myinvest_agent_message_kind":"draft_note"}' WHERE id=61`,
        `UPDATE messages SET created_at='2026-09-21 11:00Z' WHERE id=62`,
      ]
      for (const mutation of mutations) {
        await client.query('SAVEPOINT automatic_source_case')
        await client.query(mutation)
        expect(
          (
            await discoverAutomaticLearningSources(database, registry, { now })
          ).sources,
        ).toEqual([])
        await client.query('ROLLBACK TO SAVEPOINT automatic_source_case')
      }

      await client.query('SAVEPOINT automatic_source_case')
      await client.query(`INSERT INTO messages
        (id,account_id,conversation_id,inbox_id,message_type,private,sender_type,sender_id,content,content_attributes,created_at,status)
        VALUES (59,101,700,17,0,false,'Contact',900,'Spätere Frage','{}','2026-09-20 10:01:30Z',1)`)
      expect(
        (await discoverAutomaticLearningSources(database, registry, { now }))
          .sources,
      ).toEqual([])
      await client.query('ROLLBACK TO SAVEPOINT automatic_source_case')

      await client.query('SAVEPOINT automatic_source_case')
      await client.query(`INSERT INTO messages
        (id,account_id,conversation_id,inbox_id,message_type,private,sender_type,sender_id,content,content_attributes,created_at,status)
        VALUES (60,101,700,17,1,true,'AgentBot',801,E'KI-Entwurf\\n\\nAntwortvorschlag:\\nEin neuerer Entwurf.\\nQuellen: Hilfe','{"myinvest_agent_delivery_id":"55","myinvest_agent_message_kind":"draft_note"}','2026-09-20 10:01:30Z',1)`)
      expect(
        (await discoverAutomaticLearningSources(database, registry, { now }))
          .sources[0]?.source.draftMessageId,
      ).toBe(60)
      await client.query('ROLLBACK TO SAVEPOINT automatic_source_case')

      await client.query('SAVEPOINT automatic_source_case')
      await client.query(`INSERT INTO messages
        (id,account_id,conversation_id,inbox_id,message_type,private,sender_type,sender_id,content,content_attributes,created_at,status)
        VALUES (58,101,700,17,1,true,'AgentBot',801,'Private Dokumenthilfe','{"myinvest_agent_delivery_id":"55","myinvest_agent_message_kind":"document_assistance_note"}','2026-09-20 10:00:30Z',1)`)
      expect(
        (await discoverAutomaticLearningSources(database, registry, { now }))
          .sources,
      ).toEqual([])
      await client.query('ROLLBACK TO SAVEPOINT automatic_source_case')
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  },
)
