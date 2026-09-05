import pg from 'pg'
import { parseTenantConfig } from '../config.js'
import { tenantKeySchema, type TenantKey } from '../domain.js'
import { extractLiveCandidates, type LiveConversation, type LiveMessage } from './mine-conversations.js'
import { HANDED_OFF_DELIVERIES_SQL, LIVE_MESSAGES_SQL } from './live-queries.js'
import { storeExtractedCandidates } from './repository.js'

// Mining-Lauf: liest jede kuerzlich uebergebene Delivery, loest Chatwoots
// account-gebundene display_id korrekt zur internen conversation.id auf und
// lernt ausschliesslich aus Antworten, die ein Mensch wirklich gesendet hat.
// Der Sendeklick beantwortet einen Kunden, er genehmigt kein allgemeines
// Antwortwissen. Kandidaten warten auf explizite Freigabe im Lernbereich.
//   node dist/learning/mine-cli.js [--days 7] [--tenant saas]
const databaseUrl = process.env.DATABASE_URL || process.env.CLAUDE_AGENT_DATABASE_URL
const chatwootDatabaseUrl = process.env.CHATWOOT_DATABASE_URL
const tenantsJson = process.env.TENANTS_JSON
if (!databaseUrl) throw new Error('DATABASE_URL is required')
if (!chatwootDatabaseUrl) throw new Error('CHATWOOT_DATABASE_URL is required')
if (!tenantsJson) throw new Error('TENANTS_JSON is required')

const daysArg = process.argv.indexOf('--days')
const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 7
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days 1..90')
const tenantArg = process.argv.indexOf('--tenant')
const tenantFilter = tenantArg >= 0 ? tenantKeySchema.parse(process.argv[tenantArg + 1]) : null
const tenantRegistry = parseTenantConfig(tenantsJson)
const accountByTenant = new Map(tenantRegistry.map((tenant) => [tenant.key, tenant.accountId]))

const agentPool = new pg.Pool({ connectionString: databaseUrl })
const chatwootPool = new pg.Pool({ connectionString: chatwootDatabaseUrl })

interface HandedOffRow {
  tenant_key: TenantKey
  conversation_id: string
}

interface MessageRow {
  conversation_display_id: string
  message_id: string
  message_type: number
  sender_type: string | null
  private: boolean
  content: string
  created_at: Date
  external_echo: boolean
  from_automation: boolean
  from_campaign: boolean
  agent_kind: string | null
}

try {
  const handedOff = await agentPool.query<HandedOffRow & Record<string, unknown>>(
    HANDED_OFF_DELIVERIES_SQL,
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

  for (const [tenant, conversationDisplayIds] of byTenant) {
    const accountId = accountByTenant.get(tenant)
    if (!accountId) throw new Error(`Missing Chatwoot account for tenant ${tenant}`)
    const messages = await chatwootPool.query<MessageRow & Record<string, unknown>>(
      LIVE_MESSAGES_SQL,
      [accountId, conversationDisplayIds],
    )
    const grouped = new Map<string, LiveMessage[]>()
    for (const row of messages.rows) {
      const list = grouped.get(row.conversation_display_id) ?? []
      list.push({
        messageId: Number(row.message_id),
        messageType: row.message_type,
        senderType: row.sender_type ?? '',
        private: row.private,
        content: row.content,
        createdAt: row.created_at,
        externalEcho: row.external_echo,
        fromAutomation: row.from_automation,
        fromCampaign: row.from_campaign,
        agentKind: row.agent_kind ?? undefined,
      })
      grouped.set(row.conversation_display_id, list)
    }
    const conversations: LiveConversation[] = conversationDisplayIds.map((displayId) => ({
      conversationId: Number(displayId),
      handedOff: true,
      messages: grouped.get(displayId) ?? [],
    }))
    const extraction = extractLiveCandidates({ tenant, exportId, conversations })
    examinedConversations += extraction.examinedConversations
    rejectedConversations += extraction.rejectedConversations
    if (extraction.candidates.length === 0) continue

    const stored = await storeExtractedCandidates(agentPool, extraction.candidates)
    inserted += stored.inserted
    refreshed += stored.refreshed
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
      published: 0,
    }),
  )
} finally {
  await agentPool.end()
  await chatwootPool.end()
}
