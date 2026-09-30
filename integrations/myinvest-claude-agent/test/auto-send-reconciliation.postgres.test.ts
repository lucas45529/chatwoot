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
    const log = new PostgresAutoSendLog(pool, undefined, pool)
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

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('releases a draft-only handoff lock nobody has answered yet', async () => {
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
    const log = new PostgresAutoSendLog(pool, undefined, pool)
    // Conversation assigned to the review assignee (7) by the old forced-approval
    // regime; the agent only left a composer draft, no human ever answered.
    const input = {
      tenantKey: 'saas' as const, conversationId: 77, accountId: 101, inboxId: 17,
      currentMessageId: 55, releasableAssigneeIds: [7],
    }
    const seed = async (block: boolean) => {
      await pool.query('TRUNCATE conversations, messages, agent_auto_send_blocks, agent_conversation_states, agent_delivery_ledger')
      await pool.query(`INSERT INTO conversations VALUES (900,77,101,17,7)`)
      await pool.query(`INSERT INTO messages (id,created_at) VALUES (50,'2026-09-19 10:00Z'),(55,'2026-09-19 12:00Z')`)
      await pool.query(`INSERT INTO messages (id,sender_type,message_type,private,created_at,content_attributes)
        VALUES (52,'AgentBot',1,true,'2026-09-19 11:31Z',
          '{"myinvest_agent_message_kind":"draft_note","myinvest_agent_delivery_id":"50"}')`)
      if (block) await pool.query(`INSERT INTO agent_auto_send_blocks VALUES ('saas',77,'agent_handoff','2026-09-19 11:30Z')`)
      await pool.query(`INSERT INTO agent_conversation_states VALUES ('saas',77,'handed_off','2026-09-19 11:32Z')`)
      await pool.query(`INSERT INTO agent_delivery_ledger VALUES ('saas',77,50,'handed_off','2026-09-19 11:32Z')`)
    }
    const released = async () => {
      expect(await log.reconcileStaleHumanReply(input)).toBe(true)
      expect((await pool.query('SELECT 1 FROM agent_auto_send_blocks')).rowCount).toBe(0)
      expect((await pool.query<{ status: string }>('SELECT status FROM agent_conversation_states')).rows[0]?.status).toBe('active')
    }
    const remainsLocked = async () => {
      expect(await log.reconcileStaleHumanReply(input)).toBe(false)
      expect((await pool.query<{ status: string }>('SELECT status FROM agent_conversation_states')).rows[0]?.status).toBe('handed_off')
    }

    await seed(true)
    await released()
    await seed(false)
    await released()

    // A human answered publicly: stays with the human.
    await seed(true)
    await pool.query(`INSERT INTO messages (id,sender_type,message_type,created_at) VALUES (53,'User',1,'2026-09-19 11:45Z')`)
    await remainsLocked()
    // A real handoff with a note (e.g. sensitive topic): stays with the human.
    await seed(true)
    await pool.query(`INSERT INTO messages (id,sender_type,message_type,private,created_at,content_attributes)
      VALUES (54,'AgentBot',1,true,'2026-09-19 11:45Z','{"myinvest_agent_message_kind":"handoff_note"}')`)
    await remainsLocked()
    // Taken over by another agent.
    await seed(true)
    await pool.query('UPDATE conversations SET assignee_id = 9')
    await remainsLocked()
    // Handed off without a draft (not draft-originated).
    await seed(false)
    await pool.query('DELETE FROM messages WHERE id = 52')
    await remainsLocked()
    // A failed handoff leaves only the block (no handed_off state, no draft): stays locked.
    await seed(true)
    await pool.query('DELETE FROM agent_conversation_states')
    await pool.query('DELETE FROM messages WHERE id = 52')
    expect(await log.reconcileStaleHumanReply(input)).toBe(false)
    expect((await pool.query('SELECT 1 FROM agent_auto_send_blocks')).rowCount).toBe(1)
    // Without the explicit releasable assignee list, an assigned conversation stays locked.
    await seed(true)
    expect(await log.reconcileStaleHumanReply({ ...input, releasableAssigneeIds: [] })).toBe(false)
  } finally {
    await pool.end()
  }
})

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('never joins Chatwoot and agent tables: they live in separate databases', async () => {
  const admin = new Pool({ connectionString: process.env.LEARNING_TEST_DATABASE_URL, max: 1 })
  const suffix = String(process.pid)
  const cw = `cw_split_${suffix}`
  const ag = `agent_split_${suffix}`
  await admin.query(`CREATE SCHEMA ${cw}; CREATE SCHEMA ${ag}`)
  const chatwoot = new Pool({ connectionString: process.env.LEARNING_TEST_DATABASE_URL, max: 1, options: `-c search_path=${cw}` })
  const agent = new Pool({ connectionString: process.env.LEARNING_TEST_DATABASE_URL, max: 2, options: `-c search_path=${ag}` })
  try {
    // Real Chatwoot types: created_at is timestamp WITHOUT time zone (UTC).
    await chatwoot.query(`CREATE TABLE conversations (id bigint, display_id bigint, account_id bigint, inbox_id bigint, assignee_id bigint)`)
    await chatwoot.query(`CREATE TABLE messages (
      id bigint, account_id bigint DEFAULT 101, conversation_id bigint DEFAULT 900,
      inbox_id bigint DEFAULT 17, sender_type text DEFAULT 'Contact',
      message_type integer DEFAULT 0, private boolean DEFAULT false,
      created_at timestamp without time zone, content_attributes json DEFAULT '{}',
      additional_attributes jsonb DEFAULT '{}', source_id text)`)
    await agent.query(`CREATE TABLE agent_auto_send_blocks (tenant_key text, conversation_id bigint, reason text, created_at timestamptz)`)
    await agent.query(`CREATE TABLE agent_conversation_states (tenant_key text, conversation_id bigint, status text, updated_at timestamptz)`)
    await agent.query(`CREATE TABLE agent_delivery_ledger (tenant_key text, conversation_id bigint, message_id bigint, status text, updated_at timestamptz)`)
    await chatwoot.query(`INSERT INTO conversations VALUES (900,77,101,17,7)`)
    await chatwoot.query(`INSERT INTO messages (id,created_at) VALUES (50,'2026-09-19 10:00'),(55,'2026-09-19 12:00')`)
    await chatwoot.query(`INSERT INTO messages (id,sender_type,message_type,private,created_at,content_attributes)
      VALUES (52,'AgentBot',1,true,'2026-09-19 11:31','{"myinvest_agent_message_kind":"draft_note","myinvest_agent_delivery_id":"50"}')`)
    await agent.query(`INSERT INTO agent_auto_send_blocks VALUES ('saas',77,'agent_handoff','2026-09-19 11:30Z')`)
    await agent.query(`INSERT INTO agent_conversation_states VALUES ('saas',77,'handed_off','2026-09-19 11:32Z')`)
    await agent.query(`INSERT INTO agent_delivery_ledger VALUES ('saas',77,50,'handed_off','2026-09-19 11:32Z')`)

    const log = new PostgresAutoSendLog(agent, undefined, chatwoot)
    await expect(log.reconcileStaleHumanReply({
      tenantKey: 'saas', conversationId: 77, accountId: 101, inboxId: 17,
      currentMessageId: 55, releasableAssigneeIds: [7],
    })).resolves.toBe(true)
    expect((await agent.query('SELECT 1 FROM agent_auto_send_blocks')).rowCount).toBe(0)
    expect((await agent.query<{ status: string }>('SELECT status FROM agent_conversation_states')).rows[0]?.status).toBe('active')
  } finally {
    await chatwoot.end()
    await agent.end()
    await admin.query(`DROP SCHEMA ${cw} CASCADE; DROP SCHEMA ${ag} CASCADE`)
    await admin.end()
  }
})
