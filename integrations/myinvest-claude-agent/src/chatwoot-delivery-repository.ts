import { contactFingerprint } from './auto-send.js'
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
}
export interface ChatwootConversationContextStore {
  loadContext(input: ConversationContextRequest): Promise<ConversationContext | undefined>
}

interface ContextMetadataRow extends Record<string, unknown> {
  conversation_id: string
  contact_id: string | null
  contact_email: string | null
  cached_label_list: string | null
  last_human_message_id: string | null
  last_agent_handoff_id: string | null
  last_agent_draft_note: string | null
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
 * Nachrichten und liefert einen kurzen, PII-redigierten Verlauf. Die E-Mail
 * verlaesst ihn nur im signierten Gehirn-Body fuer kontaktgebundene Werkzeuge;
 * sie landet weder im Verlauf noch in Logs.
 */
export class PostgresChatwootDeliveryStore
  implements ChatwootDeliveryStore, ChatwootConversationContextStore
{
  constructor(
    private readonly database: Queryable,
    private readonly pseudonymizationKey: string,
  ) {}

  async healthCheck(): Promise<void> {
    await this.database.query(
      'SELECT 1 FROM messages CROSS JOIN conversations CROSS JOIN contacts WHERE false LIMIT 1',
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

  async loadContext(
    input: ConversationContextRequest,
  ): Promise<ConversationContext | undefined> {
    const metadata = await this.database.query<ContextMetadataRow>(
      `SELECT conversation.id::text AS conversation_id,
              conversation.contact_id::text AS contact_id,
              contact.email AS contact_email,
              conversation.cached_label_list,
              (
                SELECT max(human_message.id)::text
                  FROM messages AS human_message
                 WHERE human_message.account_id = $1
                   AND human_message.conversation_id = conversation.id
                   AND human_message.sender_type = 'User'
                   AND human_message.private = false
              ) AS last_human_message_id,
              (
                SELECT max(marker.id)::text
                  FROM messages AS marker
                 WHERE marker.account_id = $1
                   AND marker.sender_type = 'AgentBot'
                   AND marker.conversation_id = conversation.id
                   AND CASE WHEN json_typeof(marker.content_attributes) = 'string'
                            THEN (marker.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                            ELSE marker.content_attributes ->> 'myinvest_agent_message_kind' END
                       IN ('handoff_ack', 'handoff_note', 'draft_note', 'clarify_draft_note')
              ) AS last_agent_handoff_id,
              (
                SELECT draft_note.content
                  FROM messages AS draft_note
                 WHERE draft_note.account_id = $1
                   AND draft_note.sender_type = 'AgentBot'
                   AND draft_note.conversation_id = conversation.id
                   AND draft_note.private = true
                   AND CASE WHEN json_typeof(draft_note.content_attributes) = 'string'
                            THEN (draft_note.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                            ELSE draft_note.content_attributes ->> 'myinvest_agent_message_kind' END
                       IN ('handoff_note', 'draft_note', 'clarify_draft_note')
                   AND draft_note.content LIKE '%Antwortvorschlag:%'
                 ORDER BY draft_note.id DESC
                 LIMIT 1
              ) AS last_agent_draft_note
         FROM conversations AS conversation
         LEFT JOIN contacts AS contact
           ON contact.account_id = conversation.account_id
          AND contact.id = conversation.contact_id
        WHERE conversation.account_id = $1
          AND conversation.display_id = $2`,
      [input.accountId, input.conversationDisplayId],
    )
    const conversation = metadata.rows[0]
    if (!conversation) return undefined

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
    for (const message of messages.rows) {
      const role = conversationRole(message)
      if (!role) continue
      const redacted = redactSupportText(message.content).text.trim()
      if (!redacted || containsResidualPersonalData(redacted)) continue
      turns.push({ role, text: redacted.slice(0, 1_500) })
    }
    const lastHumanMessageId = Number(conversation.last_human_message_id ?? 0)
    const lastBotHandoffId = Number(conversation.last_agent_handoff_id ?? 0)

    return {
      turns,
      labels: (conversation.cached_label_list ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean),
      humanRepliedAfterBot: lastBotHandoffId > 0 && lastHumanMessageId > lastBotHandoffId,
      humanEverReplied: lastHumanMessageId > 0,
      previousAgentDraft: extractAgentDraft(conversation.last_agent_draft_note),
      // Keyed Pseudonym statt Kontakt-ID: die Ratengrenze braucht nur Gleichheit.
      contactHash: conversation.contact_id
        ? contactFingerprint(
            this.pseudonymizationKey,
            input.accountId,
            conversation.contact_id,
          )
        : undefined,
      contactEmail:
        typeof conversation.contact_email === 'string' &&
        conversation.contact_email.length <= 320 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(conversation.contact_email.trim())
          ? conversation.contact_email.trim().toLowerCase()
          : undefined,
    }
  }
}

export function extractAgentDraft(note: string | null): string | undefined {
  if (!note) return undefined
  const marker = '\n\nAntwortvorschlag:\n'
  const start = note.indexOf(marker)
  if (start < 0) return undefined
  const body = note.slice(start + marker.length)
  const sourceStart = Math.max(
    body.lastIndexOf('\nQuellen:'),
    body.lastIndexOf('\nGrundlage:'),
  )
  if (sourceStart < 0) return undefined
  const draft = body.slice(0, sourceStart).trim()
  return draft || undefined
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
