import type { ConversationTurn } from './domain.js'
import { containsResidualPersonalData, redactSupportText } from './learning/extractor.js'

interface HistoryDatabase {
  query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<{ rows: Row[] }>
}
interface HistoryRow extends Record<string, unknown> {
  id: string | number
  created_at: Date | string
  message_type: number
  sender_type: string | null
  content: string
  from_automation: boolean
  from_campaign: boolean
  external_echo: boolean
}

// Live context is not reusable training material. Keep valid calendar dates and
// meeting-link presence, but never the URL token or phone number itself.
export function redactConversationText(input: string): string {
  const dates: string[] = []
  const protectedText = input.replace(/\b(?:https?:\/\/|www\.)\S+/giu, (url) =>
    /^https?:\/\/(?:[\w-]+\.)?zoom\.us(?:\/|$)/iu.test(url) ? '[ZOOM-LINK]' : '[LINK]',
  ).replace(/(?<![\d./-])(?:([0-2]?\d|3[01])\.(0?[1-9]|1[0-2])\.((?:19|20)\d{2})|((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))(?![\d/-]|\.\d)/gu, (date) => {
    const token = `CALENDARDATE${dates.length}PLACEHOLDER`
    dates.push(date)
    return token
  })
  const redacted = redactSupportText(protectedText).text.trim()
  if (!redacted || containsResidualPersonalData(redacted)) return ''
  return redacted.replace(/CALENDARDATE(\d+)PLACEHOLDER/gu, (token, index: string) => dates[Number(index)] ?? token)
}

/** One history projection for both live answers and source-bound learning.
 * Only persisted public text before the exact source timestamp/id is eligible.
 * Failed outbound rows and unsent external-channel messages are not evidence. */
export async function loadConversationHistory(database: HistoryDatabase, input: {
  accountId: number
  conversationId: string
  currentMessageId: number
  inboxId: number
}): Promise<ConversationTurn[]> {
  const result = await database.query<HistoryRow>(`
    SELECT recent.* FROM (
      SELECT message.id, message.created_at, message.message_type, message.sender_type,
        left(coalesce(nullif(message.content, ''), message.processed_message_content), 6000) AS content,
        (attrs.value ->> 'external_echo') IS NOT NULL AS external_echo,
        (attrs.value ->> 'automation_rule_id') IS NOT NULL AS from_automation,
        (message.additional_attributes ? 'campaign_id') AS from_campaign
      FROM messages message
      JOIN messages current_message ON current_message.id = $3
        AND current_message.account_id = $1 AND current_message.conversation_id = $2
        AND current_message.inbox_id = $4
      JOIN conversations conversation ON conversation.id = message.conversation_id
        AND conversation.account_id = $1 AND conversation.inbox_id = $4
      CROSS JOIN LATERAL (SELECT CASE WHEN json_typeof(message.content_attributes) = 'string'
        THEN (message.content_attributes #>> '{}')::json ELSE message.content_attributes END AS value) attrs
      WHERE message.account_id = $1 AND message.conversation_id = $2 AND message.inbox_id = $4
        AND (message.created_at, message.id) < (current_message.created_at, current_message.id)
        AND message.private = false AND message.message_type IN (0, 1, 3)
        AND message.content_type IN (0, 8)
        AND (message.message_type = 0 OR (message.status IN (0, 1, 2)
          AND (message.status IN (1, 2) OR nullif(message.source_id, '') IS NOT NULL
            OR (coalesce(conversation.custom_attributes ->> 'myinvest_channel', 'web') = 'web'
              AND coalesce(current_message.source_id, '') NOT LIKE 'wamid.%'
              AND message.sender_type IN ('User', 'AgentBot', 'Captain::Assistant')))))
        AND coalesce(nullif(message.content, ''), message.processed_message_content, '') <> ''
        AND (attrs.value ->> 'myinvest_tenant' IS NULL
          OR attrs.value ->> 'myinvest_tenant' = coalesce(CASE WHEN json_typeof(current_message.content_attributes) = 'string'
            THEN (current_message.content_attributes #>> '{}')::json ->> 'myinvest_tenant'
            ELSE current_message.content_attributes ->> 'myinvest_tenant' END, conversation.custom_attributes ->> 'myinvest_tenant'))
      ORDER BY message.created_at DESC, message.id DESC LIMIT 100
    ) recent ORDER BY recent.created_at ASC, recent.id ASC`,
  [input.accountId, input.conversationId, input.currentMessageId, input.inboxId])
  const turns: ConversationTurn[] = []
  const evidence: Array<{ index: number; role: ConversationTurn['role']; label: string; text: string; contact: boolean }> = []
  for (const row of result.rows) {
    let role: ConversationTurn['role']
    let prefix = ''
    if (row.message_type === 0 && (!row.sender_type || row.sender_type === 'Contact')) role = 'customer'
    else if (row.message_type === 1 || row.message_type === 3) {
      if (row.from_automation || row.from_campaign) {
        role = 'assistant'
        prefix = row.from_campaign ? '[Kampagnennachricht] ' : '[Automatische Nachricht] '
      } else if (row.sender_type === 'User' || (!row.sender_type && row.external_echo)) role = 'human'
      else if (!row.sender_type || row.sender_type === 'AgentBot' || row.sender_type === 'Captain::Assistant') {
        role = 'assistant'
        if (!row.sender_type) prefix = '[Gesendete Nachricht] '
      } else continue
    } else continue
    const text = typeof row.content === 'string' ? redactConversationText(row.content) : ''
    if (!text) continue
    const excerpt = role === 'customer' ? contactExcerpt(row.content) : undefined
    const date = row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
    if (/^[1-9]\d{0,18}$/.test(String(row.id)) && Number.isFinite(date.getTime())) {
      const speaker = role === 'customer' ? 'Kunde' : role === 'human' ? 'Mitarbeiter' : 'Assistent'
      evidence.push({ index: turns.length, role, label: `#${row.id} · ${date.toISOString()} · ${speaker}: `, text: excerpt ?? `${prefix}${text}`, contact: Boolean(excerpt) })
    }
    turns.push({ role, text: `${prefix}${text}`.slice(0, 1500) })
  }
  if (turns.length > 12) {
    const contacts = evidence.filter(quote => quote.contact && quote.index < turns.length - 11).slice(-4)
    if (contacts.length) {
      const selected = new Set(contacts)
      for (const contact of contacts) {
        // Preserve the preceding exchange as evidence, without inferring which
        // contact answers which question. Every quoted role remains explicit.
        const previousAgent = evidence.filter(quote => quote.index < contact.index && quote.role !== 'customer').at(-1)
        if (!previousAgent) continue
        selected.add(previousAgent)
        const previousCustomer = evidence.find(quote => quote.index === previousAgent.index - 1 && quote.role === 'customer')
        if (previousCustomer) selected.add(previousCustomer)
      }
      const quotes = [...selected].sort((a, b) => a.index - b.index)
      const heading = 'Ältere Kundenangaben mit öffentlichem Gesprächskontext (redigierte Originalauszüge; kein neuer Stand). Spätere Korrekturen haben Vorrang:\n'
      const quoteBudget = Math.min(250, Math.floor((1500 - heading.length - quotes.reduce((sum, quote) => sum + quote.label.length + 3, 0)) / quotes.length))
      return [{ role: 'customer', text: heading + quotes.map(quote => `${quote.label}„${boundedQuote(quote.text, quoteBudget, quote.contact)}“`).join('\n') }, ...turns.slice(-11)]
    }
  }
  return turns.slice(-12)
}

// Selection identifies supplied contact data, not facts inferred from AI text.
// The same public, tenant-bound SQL projection supplies recent and older turns.
function contactExcerpt(text: string): string | undefined {
  const contact = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+\d{1,3}|\b0[1-9])[\d ()/-]{7,}/u.exec(text)
  if (!contact) return undefined
  // Center on the actual match so a long introduction cannot hide the evidence.
  const start = Math.max(0, contact.index - 100)
  const end = Math.min(text.length, contact.index + contact[0].length + 100)
  const excerpt = redactConversationText(text.slice(start, end))
  if (!excerpt) return undefined
  return `${start > 0 ? '[gekürzt] … ' : ''}${excerpt.slice(0, 250)}${end < text.length || excerpt.length > 250 ? ' … [gekürzt]' : ''}`
}


function boundedQuote(text: string, limit: number, contact: boolean): string {
  if (text.length <= limit) return text
  const marker = ' … [gekürzt]'
  const available = Math.max(0, limit - marker.length * 2)
  const match = contact ? /\[(?:E-MAIL\/ACCOUNT|TELEFON\/NUMMER)\]/u.exec(text) : null
  const start = match ? Math.max(0, match.index - Math.floor((available - match[0].length) / 2)) : 0
  return `${start ? '[gekürzt] … ' : ''}${text.slice(start, start + available)}${start + available < text.length ? marker : ''}`
}
