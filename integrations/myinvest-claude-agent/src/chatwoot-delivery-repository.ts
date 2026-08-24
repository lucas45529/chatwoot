import type { DeliveryMessageKind } from './chatwoot-client.js'
import type {
  ConversationContext,
  ConversationTurn,
  ConversationTurnRole,
} from './domain.js'
import {
  containsResidualPersonalData,
  redactSupportText,
} from './learning/extractor.js'

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export interface ChatwootDeliveryStore {
  exists(input: {
    accountId: number
    conversationDisplayId: number
    deliveryId: number
    kind: DeliveryMessageKind
  }): Promise<boolean>
}

export interface ConversationContextRequest {
  accountId: number
  conversationDisplayId: number
  currentMessageId: number
  identity: {
    hasEmail: boolean
    hasPhone: boolean
    hasIdentifier: boolean
  }
}

export interface ChatwootConversationContextStore {
  loadContext(input: ConversationContextRequest): Promise<ConversationContext>
}

interface ContextMetadataRow extends Record<string, unknown> {
  conversation_id: string
  cached_label_list: string | null
  last_agent_handoff_id: string | null
}

interface ContextMessageRow extends Record<string, unknown> {
  message_id: string
  message_type: number
  sender_type: string | null
  content: string
  created_at: Date
  agent_kind: string | null
  external_echo: boolean
  from_automation: boolean
  from_campaign: boolean
}

/**
 * Account-gebundener Read-only-Blick in Chatwoot. Er dedupliziert AgentBot-
 * Nachrichten und liefert einen kurzen, PII-redigierten Verlauf; Rohdaten oder
 * Kontaktwerte werden weder geloggt noch an das Modell weitergereicht.
 */
export class PostgresChatwootDeliveryStore
  implements ChatwootDeliveryStore, ChatwootConversationContextStore
{
  constructor(private readonly database: Queryable) {}

  async healthCheck(): Promise<void> {
    // Erzwingt echte SELECT-Rechte auf den genutzten Tabellen.
    await this.database.query(
      'SELECT 1 FROM messages CROSS JOIN conversations WHERE false LIMIT 1',
    )
  }

  async exists(input: {
    accountId: number
    conversationDisplayId: number
    deliveryId: number
    kind: DeliveryMessageKind
  }): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM messages AS message
           JOIN conversations AS conversation
             ON conversation.id = message.conversation_id
            AND conversation.account_id = $1
          WHERE message.account_id = $1
            AND conversation.display_id = $2
            AND CASE WHEN json_typeof(message.content_attributes) = 'string'
                     THEN (message.content_attributes #>> '{}')::json ->> 'myinvest_agent_delivery_id'
                     ELSE message.content_attributes ->> 'myinvest_agent_delivery_id' END = $3
            AND CASE WHEN json_typeof(message.content_attributes) = 'string'
                     THEN (message.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                     ELSE message.content_attributes ->> 'myinvest_agent_message_kind' END = $4
       ) AS exists`,
      [input.accountId, input.conversationDisplayId, String(input.deliveryId), input.kind],
    )
    return result.rows[0]?.exists === true
  }

  async loadContext(input: ConversationContextRequest): Promise<ConversationContext> {
    const metadata = await this.database.query<ContextMetadataRow>(
      `SELECT conversation.id::text AS conversation_id,
              conversation.cached_label_list,
              (
                SELECT max(marker.id)::text
                  FROM messages AS marker
                 WHERE marker.account_id = $1
                   AND marker.conversation_id = conversation.id
                   AND marker.sender_type = 'AgentBot'
                   AND CASE WHEN json_typeof(marker.content_attributes) = 'string'
                            THEN (marker.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                            ELSE marker.content_attributes ->> 'myinvest_agent_message_kind' END
                       IN ('handoff_ack', 'handoff_note', 'draft_note', 'clarify_draft_note')
              ) AS last_agent_handoff_id
         FROM conversations AS conversation
        WHERE conversation.account_id = $1
          AND conversation.display_id = $2`,
      [input.accountId, input.conversationDisplayId],
    )
    const conversation = metadata.rows[0]
    if (!conversation) throw new Error('Chatwoot conversation context was not found')

    const messages = await this.database.query<ContextMessageRow>(
      `SELECT recent.message_id, recent.message_type, recent.sender_type,
              recent.content, recent.created_at, recent.agent_kind,
              recent.external_echo, recent.from_automation, recent.from_campaign
         FROM (
           SELECT message.id::text AS message_id, message.message_type,
                  message.sender_type, message.content, message.created_at,
                  CASE WHEN json_typeof(message.content_attributes) = 'string'
                       THEN (message.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                       ELSE message.content_attributes ->> 'myinvest_agent_message_kind' END AS agent_kind,
                  (CASE WHEN json_typeof(message.content_attributes) = 'string'
                        THEN (message.content_attributes #>> '{}')::json ->> 'external_echo'
                        ELSE message.content_attributes ->> 'external_echo' END) IS NOT NULL AS external_echo,
                  (CASE WHEN json_typeof(message.content_attributes) = 'string'
                        THEN (message.content_attributes #>> '{}')::json ->> 'automation_rule_id'
                        ELSE message.content_attributes ->> 'automation_rule_id' END) IS NOT NULL AS from_automation,
                  (message.additional_attributes ? 'campaign_id') AS from_campaign
             FROM messages AS message
            WHERE message.account_id = $1
              AND message.conversation_id = $2
              AND message.id <> $3
              AND message.private = false
              AND message.message_type IN (0, 1)
              AND message.content_type = 0
              AND message.content IS NOT NULL
              AND message.content <> ''
              AND message.created_at >= now() - interval '30 days'
            ORDER BY message.created_at DESC, message.id DESC
            LIMIT 12
         ) AS recent
        ORDER BY recent.created_at ASC, recent.message_id::bigint ASC`,
      [input.accountId, conversation.conversation_id, input.currentMessageId],
    )

    const turns: ConversationTurn[] = []
    let lastHumanMessageId = 0
    for (const message of messages.rows) {
      const role = conversationRole(message)
      if (!role) continue
      // Der Resume-Marker haengt am menschlichen Absender, nicht am Text: er
      // zaehlt auch dann, wenn die Redaction den Turn danach verwirft.
      if (role === 'human') {
        lastHumanMessageId = Math.max(lastHumanMessageId, Number(message.message_id))
      }
      const redacted = redactSupportText(message.content).text.trim()
      if (!redacted || containsResidualPersonalData(redacted)) continue
      turns.push({ role, text: redacted.slice(0, 1_500) })
    }
    const lastBotHandoffId = Number(conversation.last_agent_handoff_id ?? 0)

    return {
      turns,
      labels: (conversation.cached_label_list ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean),
      needsIdentityClarification: !input.identity.hasEmail && !input.identity.hasIdentifier,
      hasContactChannel:
        input.identity.hasEmail || input.identity.hasPhone || input.identity.hasIdentifier,
      humanRepliedAfterBot: lastBotHandoffId > 0 && lastHumanMessageId > lastBotHandoffId,
    }
  }
}

function conversationRole(message: ContextMessageRow): ConversationTurnRole | undefined {
  if (message.from_automation || message.from_campaign) return undefined
  const sender = message.sender_type
  if (message.message_type === 0) {
    return !sender || sender === 'Contact' ? 'customer' : undefined
  }
  if (message.message_type !== 1) return undefined
  if (sender === 'AgentBot' || sender === 'Captain::Assistant') return 'assistant'
  if (sender === 'User' || (!sender && message.external_echo)) return 'human'
  return undefined
}
