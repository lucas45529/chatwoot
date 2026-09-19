import { executionContextSchema, type SupportExecutionContext, type SupportChannel } from './support-brain.js'
import type { TenantKey } from './domain.js'
import { contactFingerprint } from './auto-send.js'
import type { DeliveryMessageKind } from './chatwoot-client.js'
import type { ConversationContext } from './domain.js'
import { loadConversationHistory } from './conversation-history.js'

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
    generationId?: string
  }): Promise<boolean>
}

export interface ConversationContextRequest {
  accountId: number
  inboxId: number
  conversationDisplayId: number
  currentMessageId: number
}
export interface CurrentCustomerSource { executionContext: SupportExecutionContext; content: string }
export interface CurrentCustomerSourceRequest extends ConversationContextRequest { tenant: TenantKey; channel: SupportChannel }
export interface ChatwootConversationContextStore {
  loadCurrentSource?(input: CurrentCustomerSourceRequest): Promise<CurrentCustomerSource | undefined>
  loadContext(input: ConversationContextRequest): Promise<ConversationContext | undefined>
}

interface ContextMetadataRow extends Record<string, unknown> {
  conversation_id: string
  contact_id: string | null
  contact_email: string | null
  contact_name: string | null
  contact_phone: string | null
  cached_label_list: string | null
  last_human_message_id: string | null
  last_agent_handoff_id: string | null
  last_agent_draft_note: string | null
  conversation_tenant: string | null
  conversation_channel: string | null
  source_tenant: string | null
}

/**
 * Account-gebundener Read-only-Blick in Chatwoot. Er dedupliziert AgentBot-
 * Nachrichten und liefert einen kurzen, PII-redigierten Verlauf. Kontaktangaben
 * verlassen ihn nur im signierten Gehirn-Body fuer kontaktgebundene Werkzeuge;
 * sie landen weder im Verlauf noch in Logs.
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
    generationId?: string
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
             ${input.generationId ? `AND CASE WHEN json_typeof(message.content_attributes) = 'string'
                     THEN (message.content_attributes #>> '{}')::json ->> 'myinvest_agent_generation_id'
                     ELSE message.content_attributes ->> 'myinvest_agent_generation_id' END = $5` : ''}
       ) AS exists`,
      [input.accountId, input.conversationDisplayId, String(input.deliveryId), input.kind, ...(input.generationId ? [input.generationId] : [])],
    )
    return result.rows[0]?.exists === true
  }

  async loadCurrentSource(input: CurrentCustomerSourceRequest): Promise<CurrentCustomerSource | undefined> {
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT conversation.account_id, conversation.inbox_id, conversation.display_id,
        contact.id AS contact_id, source.id AS source_id, source.created_at,
        coalesce(source.content, '') AS content,
        CASE WHEN inbox.channel_type = 'Channel::Email' THEN 'email' ELSE $6 END AS source_channel
      FROM conversations conversation
      JOIN inboxes inbox ON inbox.id = conversation.inbox_id AND inbox.account_id = conversation.account_id
      JOIN contacts contact ON contact.id = conversation.contact_id AND contact.account_id = conversation.account_id
      JOIN messages source ON source.id = $3 AND source.conversation_id = conversation.id
        AND source.account_id = conversation.account_id AND source.inbox_id = conversation.inbox_id
      WHERE conversation.account_id = $1 AND conversation.display_id = $2 AND conversation.inbox_id = $4
        AND source.private = false AND source.message_type = 0
        AND (source.sender_type IS NULL OR (source.sender_type = 'Contact' AND source.sender_id = contact.id))
        AND (conversation.custom_attributes ->> 'myinvest_tenant' IS NULL OR conversation.custom_attributes ->> 'myinvest_tenant' = $5)
        AND (conversation.custom_attributes ->> 'myinvest_channel' IS NULL OR conversation.custom_attributes ->> 'myinvest_channel' = $6)
        AND coalesce(CASE WHEN json_typeof(source.content_attributes) = 'string'
          THEN (source.content_attributes #>> '{}')::json ->> 'myinvest_tenant'
          ELSE source.content_attributes ->> 'myinvest_tenant' END, $5) = $5
        AND NOT EXISTS (
          SELECT 1 FROM messages newer WHERE newer.account_id = conversation.account_id
            AND newer.conversation_id = conversation.id AND newer.inbox_id = conversation.inbox_id
            AND newer.private = false AND (newer.created_at, newer.id) > (source.created_at, source.id)
            AND ((newer.message_type = 0 AND (newer.sender_type IS NULL OR newer.sender_type = 'Contact'))
              OR (newer.message_type IN (1,3) AND newer.sender_type = 'User'))
        )`, [input.accountId, input.conversationDisplayId, input.currentMessageId, input.inboxId, input.tenant, input.channel])
    const row = result.rows[0]
    if (!row) return undefined
    const date = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at))
    if (!Number.isFinite(date.getTime())) return undefined
    const parsed = executionContextSchema.safeParse({ accountId: Number(row.account_id), inboxId: Number(row.inbox_id), conversationId: Number(row.display_id), sourceMessageId: Number(row.source_id), contactId: Number(row.contact_id), sourceChannel: row.source_channel, sourceReceivedAt: date.toISOString(), mode: 'customer_message' })
    return parsed.success && typeof row.content === 'string' ? { executionContext: parsed.data, content: row.content } : undefined
  }

  async loadContext(
    input: ConversationContextRequest,
  ): Promise<ConversationContext | undefined> {
    const metadata = await this.database.query<ContextMetadataRow>(
      `SELECT conversation.id::text AS conversation_id,
              conversation.contact_id::text AS contact_id,
              contact.email AS contact_email,
              contact.name AS contact_name,
              contact.phone_number AS contact_phone,
              conversation.cached_label_list,
              conversation.custom_attributes ->> 'myinvest_tenant' AS conversation_tenant,
              conversation.custom_attributes ->> 'myinvest_channel' AS conversation_channel,
              CASE WHEN json_typeof(source_message.content_attributes) = 'string'
                   THEN (source_message.content_attributes #>> '{}')::json ->> 'myinvest_tenant'
                   ELSE source_message.content_attributes ->> 'myinvest_tenant' END AS source_tenant,
              (
                SELECT max(human_message.id)::text
                  FROM messages AS human_message
                 WHERE human_message.account_id = $1
                   AND human_message.conversation_id = conversation.id
                   AND human_message.inbox_id = conversation.inbox_id
                   AND human_message.sender_type = 'User'
                   AND human_message.private = false
              ) AS last_human_message_id,
              (
                SELECT max(marker.id)::text
                  FROM messages AS marker
                 WHERE marker.account_id = $1
                   AND marker.sender_type = 'AgentBot'
                   AND marker.conversation_id = conversation.id
                   AND marker.inbox_id = conversation.inbox_id
                   AND CASE WHEN json_typeof(marker.content_attributes) = 'string'
                            THEN (marker.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                            ELSE marker.content_attributes ->> 'myinvest_agent_message_kind' END
                       IN ('handoff_ack', 'handoff_note', 'draft_note', 'clarify_draft_note', 'document_assistance_note')
              ) AS last_agent_handoff_id,
              (
                SELECT draft_note.content
                  FROM messages AS draft_note
                 WHERE draft_note.account_id = $1
                   AND draft_note.sender_type = 'AgentBot'
                   AND draft_note.conversation_id = conversation.id
                   AND draft_note.inbox_id = conversation.inbox_id
                   AND draft_note.private = true
                   AND CASE WHEN json_typeof(draft_note.content_attributes) = 'string'
                            THEN (draft_note.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                            ELSE draft_note.content_attributes ->> 'myinvest_agent_message_kind' END
                       IN ('handoff_note', 'draft_note', 'clarify_draft_note', 'document_assistance_note')
                   AND draft_note.content LIKE '%Antwortvorschlag:%'
                 ORDER BY draft_note.id DESC
                 LIMIT 1
              ) AS last_agent_draft_note
         FROM conversations AS conversation
         JOIN messages AS source_message
           ON source_message.id = $3
          AND source_message.account_id = conversation.account_id
          AND source_message.conversation_id = conversation.id
          AND source_message.inbox_id = conversation.inbox_id
          AND source_message.message_type = 0
          AND source_message.private = false
          AND (source_message.sender_type IS NULL OR source_message.sender_type = 'Contact')
         LEFT JOIN contacts AS contact
           ON contact.account_id = conversation.account_id
          AND contact.id = conversation.contact_id
        WHERE conversation.account_id = $1
          AND conversation.display_id = $2
          AND conversation.inbox_id = $4`,
      [input.accountId, input.conversationDisplayId, input.currentMessageId, input.inboxId],
    )
    const conversation = metadata.rows[0]
    if (!conversation) return undefined

    const turns = await loadConversationHistory(this.database, {
      accountId: input.accountId, inboxId: input.inboxId,
      conversationId: conversation.conversation_id, currentMessageId: input.currentMessageId,
    })
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
      supportRouting: {
        conversationTenant: conversation.conversation_tenant,
        conversationChannel: conversation.conversation_channel,
        sourceTenant: conversation.source_tenant,
      },
      // Keyed Pseudonym statt Kontakt-ID: die Ratengrenze braucht nur Gleichheit.
      contactHash: conversation.contact_id
        ? contactFingerprint(
            this.pseudonymizationKey,
            input.accountId,
            conversation.contact_id,
          )
        : undefined,
      contactName: typeof conversation.contact_name === 'string' && conversation.contact_name.trim().length <= 200
        ? conversation.contact_name.trim() || undefined : undefined,
      contactPhone: typeof conversation.contact_phone === 'string' && /^\+?[0-9 ()-]{5,40}$/.test(conversation.contact_phone.trim())
        ? conversation.contact_phone.trim() : undefined,
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
