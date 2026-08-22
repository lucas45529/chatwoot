import pg from 'pg'
import { tenantKeySchema, type TenantKey } from '../domain.js'
import { extractLiveCandidates, type LiveConversation, type LiveMessage } from './mine-conversations.js'
import { storeExtractedCandidates } from './repository.js'

// Mining-Lauf: liest die zuletzt uebergebenen Konversationen (Agent-DB), holt
// die Nachrichten aus der Chatwoot-DB (read-only Rolle) und stellt neue
// Wissens-Kandidaten in Review (status pending_review).
//   node dist/learning/mine-cli.js [--days 7] [--tenant saas]
const databaseUrl = process.env.DATABASE_URL || process.env.CLAUDE_AGENT_DATABASE_URL
const chatwootDatabaseUrl = process.env.CHATWOOT_DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
if (!chatwootDatabaseUrl) throw new Error('CHATWOOT_DATABASE_URL is required')

const daysArg = process.argv.indexOf('--days')
const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 7
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days 1..90')
const tenantArg = process.argv.indexOf('--tenant')
const tenantFilter = tenantArg >= 0 ? tenantKeySchema.parse(process.argv[tenantArg + 1]) : null

const agentPool = new pg.Pool({ connectionString: databaseUrl })
const chatwootPool = new pg.Pool({ connectionString: chatwootDatabaseUrl })

interface HandedOffRow {
  tenant_key: TenantKey
  conversation_id: string
}

interface MessageRow {
  conversation_id: string
  message_id: string
  message_type: number
  sender_type: string
  private: boolean
  content: string
  created_at: Date
}

try {
  const handedOff = await agentPool.query<HandedOffRow & Record<string, unknown>>(
    `SELECT tenant_key, conversation_id::text
       FROM agent_conversation_states
      WHERE status = 'handed_off'
        AND updated_at >= now() - ($1 || ' days')::interval
        AND ($2::text IS NULL OR tenant_key = $2)`,
    [String(days), tenantFilter],
  )

  const exportId = `live-${new Date().toISOString().slice(0, 10)}`
  let examinedConversations = 0
  let rejectedConversations = 0
  let inserted = 0
  let refreshed = 0
  const byTenant = new Map<TenantKey, string[]>()
  for (const row of handedOff.rows) {
    const list = byTenant.get(row.tenant_key) ?? []
    list.push(row.conversation_id)
    byTenant.set(row.tenant_key, list)
  }

  for (const [tenant, conversationIds] of byTenant) {
    const messages = await chatwootPool.query<MessageRow & Record<string, unknown>>(
      `SELECT m.conversation_id::text, m.id::text AS message_id, m.message_type,
              m.sender_type, m.private, m.content, m.created_at
         FROM messages m
        WHERE m.conversation_id = ANY($1::bigint[])
          AND m.content IS NOT NULL
          AND m.content <> ''
        ORDER BY m.conversation_id, m.created_at ASC, m.id ASC`,
      [conversationIds],
    )
    const grouped = new Map<string, LiveMessage[]>()
    for (const row of messages.rows) {
      const list = grouped.get(row.conversation_id) ?? []
      list.push({
        messageId: Number(row.message_id),
        messageType: row.message_type,
        senderType: row.sender_type,
        private: row.private,
        content: row.content,
        createdAt: row.created_at,
      })
      grouped.set(row.conversation_id, list)
    }
    const conversations: LiveConversation[] = conversationIds.map((id) => ({
      conversationId: Number(id),
      handedOff: true,
      messages: grouped.get(id) ?? [],
    }))
    const extraction = extractLiveCandidates({ tenant, exportId, conversations })
    examinedConversations += extraction.examinedConversations
    rejectedConversations += extraction.rejectedConversations
    if (extraction.candidates.length > 0) {
      const stored = await storeExtractedCandidates(agentPool, extraction.candidates)
      inserted += stored.inserted
      refreshed += stored.refreshed
    }
  }

  console.log(
    JSON.stringify({
      event: 'live_knowledge_mined',
      days,
      tenant: tenantFilter ?? 'all',
      handed_off_conversations: handedOff.rows.length,
      examined_conversations: examinedConversations,
      rejected_conversations: rejectedConversations,
      inserted,
      refreshed,
    }),
  )
} finally {
  await agentPool.end()
  await chatwootPool.end()
}
