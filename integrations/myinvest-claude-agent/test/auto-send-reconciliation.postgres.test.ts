import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PostgresAutoSendLog } from '../src/auto-send-repository.js'

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('repairs only a proven stale human block in PostgreSQL', async () => {
  const pool = new Pool({ connectionString: process.env.LEARNING_TEST_DATABASE_URL, max: 1 })
  try {
    await pool.query(`CREATE TEMP TABLE conversations (
      id bigint, display_id bigint, account_id bigint, inbox_id bigint, assignee_id bigint)`)
    await pool.query(`CREATE TEMP TABLE messages (
      id bigint, account_id bigint DEFAULT 101, conversation_id bigint DEFAULT 900,
      inbox_id bigint DEFAULT 17, sender_type text DEFAULT 'Contact',
      message_type integer DEFAULT 0, private boolean DEFAULT false,
      created_at timestamptz, content_attributes json DEFAULT '{}',
      additional_attributes jsonb DEFAULT '{}', source_id text)`)
    await pool.query(`CREATE TEMP TABLE agent_auto_send_blocks (
      tenant_key text, conversation_id bigint, reason text, created_at timestamptz)`)
    await pool.query(`CREATE TEMP TABLE agent_conversation_states (
      tenant_key text, conversation_id bigint, status text, updated_at timestamptz)`)
    await pool.query(`CREATE TEMP TABLE agent_delivery_ledger (
      tenant_key text, conversation_id bigint, message_id bigint, status text, updated_at timestamptz)`)
    const log = new PostgresAutoSendLog(pool)
    const input = { tenantKey: 'saas' as const, conversationId: 77, accountId: 101, inboxId: 17, currentMessageId: 55 }
    const seed = async () => {
      await pool.query('TRUNCATE conversations, messages, agent_auto_send_blocks, agent_conversation_states, agent_delivery_ledger')
      await pool.query(`INSERT INTO conversations VALUES (900,77,101,17,NULL)`)
      await pool.query(`INSERT INTO messages (id,created_at) VALUES (50,'2026-09-19 10:00Z'),(55,'2026-09-19 12:00Z')`)
      await pool.query(`INSERT INTO messages (id,sender_type,message_type,created_at,source_id,content_attributes)
        VALUES (51,'User',1,'2026-09-19 10:01Z','mip:wa:saas:sys:51',
          '{"myinvest_outbound_id":"51","myinvest_outbound_kind":"reminder"}')`)
      await pool.query(`INSERT INTO messages (id,sender_type,message_type,private,created_at,content_attributes)
        VALUES (52,'AgentBot',1,true,'2026-09-19 11:31Z',
          '{"myinvest_agent_message_kind":"draft_note","myinvest_agent_delivery_id":"50"}')`)
      await pool.query(`INSERT INTO agent_auto_send_blocks VALUES ('saas',77,'human_reply','2026-09-19 11:30Z')`)
      await pool.query(`INSERT INTO agent_conversation_states VALUES ('saas',77,'handed_off','2026-09-19 11:32Z')`)
      await pool.query(`INSERT INTO agent_delivery_ledger VALUES ('saas',77,50,'handed_off','2026-09-19 11:32Z')`)
    }
    const remainsBlocked = async () => {
      expect(await log.reconcileStaleHumanReply(input)).toBe(false)
      expect((await pool.query<{ reason: string }>('SELECT reason FROM agent_auto_send_blocks')).rows[0]?.reason).toBe('human_reply')
      expect((await pool.query<{ status: string }>('SELECT status FROM agent_conversation_states')).rows[0]?.status).toBe('handed_off')
    }

    await seed()
    expect(await log.reconcileStaleHumanReply(input)).toBe(true)
    expect((await pool.query('SELECT 1 FROM agent_auto_send_blocks')).rowCount).toBe(0)
    expect((await pool.query<{ status: string }>('SELECT status FROM agent_conversation_states')).rows[0]?.status).toBe('active')

    await seed()
    await pool.query(`INSERT INTO messages (id,sender_type,message_type,created_at) VALUES (53,'User',1,'2026-09-19 11:45Z')`)
    await remainsBlocked()

    await seed()
    await pool.query(`INSERT INTO messages (id,sender_type,message_type,private,created_at,content_attributes)
      VALUES (54,'AgentBot',1,true,'2026-09-19 11:45Z','{"myinvest_agent_message_kind":"handoff_note"}')`)
    await remainsBlocked()

    await seed()
    await pool.query('UPDATE conversations SET assignee_id = 9')
    await remainsBlocked()

    await seed()
    await pool.query(`UPDATE messages SET content_attributes = '{}' WHERE id = 51`)
    await remainsBlocked()

    await seed()
    await pool.query(`UPDATE agent_conversation_states SET updated_at = '2026-09-19 11:33Z'`)
    await remainsBlocked()

    await seed()
    await pool.query(`UPDATE messages SET created_at = '2026-09-19 11:00Z' WHERE id = 55`)
    await remainsBlocked()
  } finally {
    await pool.end()
  }
})
