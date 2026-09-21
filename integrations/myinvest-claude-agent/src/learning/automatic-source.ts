import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TenantRegistry } from '../config.js'
import { tenantKeySchema, type TenantKey } from '../domain.js'
import { extractAgentDraft } from '../chatwoot-delivery-repository.js'
import { resolveSupportRoute } from '../support-routing.js'
import type {
  SupportBrainHistoryTurn,
  SupportChannel,
} from '../support-brain.js'
import {
  containsResidualPersonalData,
  directPersonalization,
  likelyNamedGreeting,
  likelySecret,
  nonReusableSupportText,
  redactSupportText,
  sensitiveTopic,
} from './extractor.js'

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const automaticLearningSourceIdsSchema = z
  .object({
    accountId: positiveId,
    inboxId: positiveId,
    /** Chatwoots account-scoped `conversations.display_id`. */
    conversationId: positiveId,
    questionMessageId: positiveId,
    draftMessageId: positiveId,
    answerMessageId: positiveId,
  })
  .strict()

export type AutomaticLearningSourceIds = z.infer<
  typeof automaticLearningSourceIdsSchema
>

export const automaticLearningCursorSchema = z
  .object({
    answeredAt: z.string().datetime({ offset: true }),
    answerMessageId: positiveId,
  })
  .strict()

export type AutomaticLearningCursor = z.infer<
  typeof automaticLearningCursorSchema
>

export interface ChatwootLearningQueryable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>
}

export interface AutomaticLearningSource {
  tenant: TenantKey
  channel: SupportChannel
  source: AutomaticLearningSourceIds
  /** Hash of immutable raw texts, routing, timestamps and IDs. */
  contentHash: string
  question: string
  previousDraft: string
  correctedAnswer: string
  history: SupportBrainHistoryTurn[]
}

export interface AutomaticLearningDiscovery {
  sources: AutomaticLearningSource[]
  nextCursor?: AutomaticLearningCursor
}

export interface DiscoverAutomaticLearningSourcesOptions {
  tenant?: TenantKey
  limit?: number
  cursor?: AutomaticLearningCursor
  now?: Date
}

type CandidateRow = Record<string, unknown> & {
  account_id: string | number
  inbox_id: string | number
  conversation_display_id: string | number
  conversation_internal_id: string | number
  question_message_id: string | number
  draft_message_id: string | number
  answer_message_id: string | number
  question: string
  draft_note: string
  corrected_answer: string
  question_created_at: Date | string
  draft_created_at: Date | string
  answer_created_at: Date | string
  answer_status: number
  conversation_tenant: string | null
  conversation_channel: string | null
  source_tenant: string | null
  default_tenant: string
  history: unknown
}

type HistoryRow = {
  id: string | number
  created_at: Date | string
  message_type: number
  sender_type: string | null
  content: string
  from_automation: boolean
  from_campaign: boolean
  external_echo: boolean
}

const HISTORY_SQL = `
LEFT JOIN LATERAL (
  SELECT coalesce(
    json_agg(to_json(history_row) ORDER BY history_row.created_at, history_row.id),
    '[]'::json
  ) AS history
  FROM (
    SELECT recent.*
    FROM (
      SELECT history_message.id, history_message.created_at,
        history_message.message_type, history_message.sender_type,
        left(coalesce(nullif(history_message.content, ''), history_message.processed_message_content), 6000) AS content,
        (history_attrs.value ->> 'automation_rule_id') IS NOT NULL AS from_automation,
        (history_message.additional_attributes ? 'campaign_id') AS from_campaign,
        (history_attrs.value ->> 'external_echo') IS NOT NULL AS external_echo
      FROM messages history_message
      CROSS JOIN LATERAL (
        SELECT CASE WHEN json_typeof(history_message.content_attributes) = 'string'
          THEN (history_message.content_attributes #>> '{}')::json
          ELSE coalesce(history_message.content_attributes, '{}'::json)
        END AS value
      ) history_attrs
      WHERE history_message.account_id = conversation.account_id
        AND history_message.conversation_id = conversation.id
        AND history_message.inbox_id = conversation.inbox_id
        AND (history_message.created_at, history_message.id)
          < (question.created_at, question.id)
        AND history_message.private = false
        AND history_message.message_type IN (0, 1, 3)
        AND history_message.content_type IN (0, 8)
        AND coalesce(nullif(history_message.content, ''), history_message.processed_message_content, '') <> ''
        AND (
          history_message.message_type = 0
          OR (
            history_message.status IN (0, 1, 2)
            AND (
              history_message.status IN (1, 2)
              OR nullif(history_message.source_id, '') IS NOT NULL
              OR (
                coalesce(conversation.custom_attributes ->> 'myinvest_channel', 'web') = 'web'
                AND history_message.sender_type IN ('User', 'AgentBot', 'Captain::Assistant')
              )
            )
          )
        )
        AND (
          history_attrs.value ->> 'myinvest_tenant' IS NULL
          OR history_attrs.value ->> 'myinvest_tenant' = coalesce(
            question_attrs.value ->> 'myinvest_tenant',
            conversation.custom_attributes ->> 'myinvest_tenant'
          )
        )
      ORDER BY history_message.created_at DESC, history_message.id DESC
      LIMIT 12
    ) recent
    ORDER BY recent.created_at, recent.id
  ) history_row
) bounded_history ON true`

const CANDIDATE_JOINS_SQL = `
FROM configured
JOIN conversations conversation
  ON conversation.account_id = configured.account_id
 AND conversation.inbox_id = configured.inbox_id
JOIN messages question
  ON question.account_id = conversation.account_id
 AND question.conversation_id = conversation.id
 AND question.inbox_id = conversation.inbox_id
 AND question.message_type = 0
 AND question.private = false
 AND question.sender_type = 'Contact'
 AND question.sender_id = conversation.contact_id
 AND question.content_type = 0
 AND char_length(coalesce(question.content, '')) BETWEEN 1 AND 12000
CROSS JOIN LATERAL (
  SELECT CASE WHEN json_typeof(question.content_attributes) = 'string'
    THEN (question.content_attributes #>> '{}')::json
    ELSE coalesce(question.content_attributes, '{}'::json)
  END AS value
) question_attrs
JOIN messages draft
  ON draft.account_id = conversation.account_id
 AND draft.conversation_id = conversation.id
 AND draft.inbox_id = conversation.inbox_id
 AND draft.message_type = 1
 AND draft.private = true
 AND draft.sender_type = 'AgentBot'
 AND draft.sender_id = configured.agent_bot_id
 AND draft.content_type = 0
 AND char_length(coalesce(draft.content, '')) BETWEEN 1 AND 20000
 AND (draft.created_at, draft.id) > (question.created_at, question.id)
CROSS JOIN LATERAL (
  SELECT CASE WHEN json_typeof(draft.content_attributes) = 'string'
    THEN (draft.content_attributes #>> '{}')::json
    ELSE coalesce(draft.content_attributes, '{}'::json)
  END AS value
) draft_attrs
JOIN messages answer
  ON answer.account_id = conversation.account_id
 AND answer.conversation_id = conversation.id
 AND answer.inbox_id = conversation.inbox_id
 AND answer.message_type = 1
 AND answer.private = false
 AND answer.sender_type = 'User'
 AND answer.content_type = 0
 AND answer.status IN (0, 1, 2)
 AND (
   answer.status IN (1, 2)
   OR (
     answer.status = 0
     AND (
       nullif(answer.source_id, '') IS NOT NULL
       OR coalesce(conversation.custom_attributes ->> 'myinvest_channel', 'web') = 'web'
     )
   )
 )
 AND char_length(coalesce(answer.content, '')) BETWEEN 1 AND 12000
 AND (answer.created_at, answer.id) > (draft.created_at, draft.id)
 AND answer.created_at <= question.created_at + interval '24 hours'
CROSS JOIN LATERAL (
  SELECT CASE WHEN json_typeof(answer.content_attributes) = 'string'
    THEN (answer.content_attributes #>> '{}')::json
    ELSE coalesce(answer.content_attributes, '{}'::json)
  END AS value
) answer_attrs
${HISTORY_SQL}`

const CANDIDATE_SAFETY_SQL = `
  AND draft_attrs.value ->> 'myinvest_agent_delivery_id' = question.id::text
  AND draft_attrs.value ->> 'myinvest_agent_message_kind' IN ('draft_note', 'clarify_draft_note', 'handoff_note')
  AND coalesce(question_attrs.value ->> 'myinvest_agent_action', '') <> 'preprocessed'
  AND coalesce(answer_attrs.value ->> 'myinvest_agent_action', '') <> 'preprocessed'
  AND answer_attrs.value ->> 'external_echo' IS NULL
  AND answer_attrs.value ->> 'automation_rule_id' IS NULL
  AND NOT (answer.additional_attributes ? 'campaign_id')
  AND coalesce(answer.source_id, '') NOT LIKE 'mip:%'
  AND NOT EXISTS (
    SELECT 1
    FROM messages newer_question
    WHERE newer_question.account_id = conversation.account_id
      AND newer_question.conversation_id = conversation.id
      AND newer_question.inbox_id = conversation.inbox_id
      AND newer_question.message_type = 0
      AND newer_question.private = false
      AND newer_question.sender_type = 'Contact'
      AND newer_question.sender_id = conversation.contact_id
      AND (newer_question.created_at, newer_question.id)
        > (question.created_at, question.id)
      AND (newer_question.created_at, newer_question.id)
        < (answer.created_at, answer.id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM messages earlier_answer
    WHERE earlier_answer.account_id = conversation.account_id
      AND earlier_answer.conversation_id = conversation.id
      AND earlier_answer.inbox_id = conversation.inbox_id
      AND earlier_answer.message_type = 1
      AND earlier_answer.private = false
      AND earlier_answer.sender_type = 'User'
      AND earlier_answer.status IN (0, 1, 2)
      AND (
        earlier_answer.status IN (1, 2)
        OR (
          earlier_answer.status = 0
          AND (
            nullif(earlier_answer.source_id, '') IS NOT NULL
            OR coalesce(conversation.custom_attributes ->> 'myinvest_channel', 'web') = 'web'
          )
        )
      )
      AND (earlier_answer.created_at, earlier_answer.id)
        > (draft.created_at, draft.id)
      AND (earlier_answer.created_at, earlier_answer.id)
        < (answer.created_at, answer.id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM messages newer_draft
    CROSS JOIN LATERAL (
      SELECT CASE WHEN json_typeof(newer_draft.content_attributes) = 'string'
        THEN (newer_draft.content_attributes #>> '{}')::json
        ELSE coalesce(newer_draft.content_attributes, '{}'::json)
      END AS value
    ) newer_draft_attrs
    WHERE newer_draft.account_id = conversation.account_id
      AND newer_draft.conversation_id = conversation.id
      AND newer_draft.inbox_id = conversation.inbox_id
      AND newer_draft.message_type = 1
      AND newer_draft.private = true
      AND newer_draft.sender_type = 'AgentBot'
      AND newer_draft.sender_id = configured.agent_bot_id
      AND newer_draft_attrs.value ->> 'myinvest_agent_delivery_id' = question.id::text
      AND newer_draft_attrs.value ->> 'myinvest_agent_message_kind' IN ('draft_note', 'clarify_draft_note', 'handoff_note')
      AND (newer_draft.created_at, newer_draft.id) > (draft.created_at, draft.id)
      AND (newer_draft.created_at, newer_draft.id) < (answer.created_at, answer.id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM messages document_marker
    CROSS JOIN LATERAL (
      SELECT CASE WHEN json_typeof(document_marker.content_attributes) = 'string'
        THEN (document_marker.content_attributes #>> '{}')::json
        ELSE coalesce(document_marker.content_attributes, '{}'::json)
      END AS value
    ) document_attrs
    WHERE document_marker.account_id = conversation.account_id
      AND document_marker.conversation_id = conversation.id
      AND document_marker.inbox_id = conversation.inbox_id
      AND document_marker.private = true
      AND document_marker.sender_type = 'AgentBot'
      AND document_attrs.value ->> 'myinvest_agent_delivery_id' = question.id::text
      AND document_attrs.value ->> 'myinvest_agent_message_kind' = 'document_assistance_note'
      AND (document_marker.created_at, document_marker.id)
        < (answer.created_at, answer.id)
  )`

const SELECT_SQL = `
SELECT conversation.account_id::text AS account_id,
  conversation.inbox_id::text AS inbox_id,
  conversation.display_id::text AS conversation_display_id,
  conversation.id::text AS conversation_internal_id,
  question.id::text AS question_message_id,
  draft.id::text AS draft_message_id,
  answer.id::text AS answer_message_id,
  question.content AS question,
  draft.content AS draft_note,
  answer.content AS corrected_answer,
  question.created_at AS question_created_at,
  draft.created_at AS draft_created_at,
  answer.created_at AS answer_created_at,
  answer.status AS answer_status,
  conversation.custom_attributes ->> 'myinvest_tenant' AS conversation_tenant,
  conversation.custom_attributes ->> 'myinvest_channel' AS conversation_channel,
  question_attrs.value ->> 'myinvest_tenant' AS source_tenant,
  configured.default_tenant,
  bounded_history.history`

const DISCOVER_SQL = `
WITH configured AS (
  SELECT *
  FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::text[])
    AS tenant(account_id, inbox_id, agent_bot_id, default_tenant)
)
${SELECT_SQL}
${CANDIDATE_JOINS_SQL}
WHERE answer.created_at >= $5::timestamptz
  AND answer.created_at <= $6::timestamptz
  AND (
    $7::timestamptz IS NULL
    OR (answer.created_at, answer.id) < ($7::timestamptz, $8::bigint)
  )
  AND (
    $10::text IS NULL
    OR coalesce(
      question_attrs.value ->> 'myinvest_tenant',
      conversation.custom_attributes ->> 'myinvest_tenant',
      configured.default_tenant
    ) = $10::text
  )
${CANDIDATE_SAFETY_SQL}
ORDER BY answer.created_at DESC, answer.id DESC
LIMIT $9`

const RESOLVE_SQL = `
WITH configured AS (
  SELECT $1::bigint AS account_id, $2::bigint AS inbox_id,
    $3::bigint AS agent_bot_id, $4::text AS default_tenant
)
${SELECT_SQL}
${CANDIDATE_JOINS_SQL}
WHERE answer.created_at <= $5::timestamptz
  AND conversation.account_id = $1
  AND conversation.inbox_id = $2
  AND conversation.display_id = $6
  AND question.id = $7
  AND draft.id = $8
  AND answer.id = $9
${CANDIDATE_SAFETY_SQL}
LIMIT 1`

function dateIso(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function id(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(String(value))
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}

function historyRows(value: unknown): HistoryRow[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (entry): entry is HistoryRow =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as HistoryRow).content === 'string',
  )
}

function safeHistory(value: unknown): SupportBrainHistoryTurn[] {
  const turns: SupportBrainHistoryTurn[] = []
  for (const row of historyRows(value).slice(-12)) {
    const redacted = redactSupportText(row.content).text
    if (!redacted || containsResidualPersonalData(redacted)) continue
    if (row.message_type === 0 && row.sender_type === 'Contact') {
      turns.push({ role: 'user', text: redacted.slice(0, 1500) })
      continue
    }
    if (row.message_type !== 1 && row.message_type !== 3) continue
    if (
      row.sender_type !== 'User' &&
      row.sender_type !== 'AgentBot' &&
      row.sender_type !== 'Captain::Assistant' &&
      row.sender_type !== null
    ) {
      continue
    }
    const prefix = row.from_campaign
      ? '[Kampagnennachricht] '
      : row.from_automation
        ? '[Automatische Nachricht] '
        : row.sender_type === null && row.external_echo
          ? '[Gesendete Nachricht] '
          : ''
    turns.push({ role: 'agent', text: `${prefix}${redacted}`.slice(0, 1500) })
  }
  return turns
}

function canonicalText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function reusableText(input: {
  question: string
  previousDraft: string
  correctedAnswer: string
}):
  | {
      question: string
      previousDraft: string
      correctedAnswer: string
    }
  | undefined {
  const question = redactSupportText(input.question).text
  const previousDraft = redactSupportText(input.previousDraft).text
  const correctedAnswer = redactSupportText(input.correctedAnswer).text
  const combined = `${question} ${previousDraft} ${correctedAnswer}`
  if (
    question.length < 8 ||
    previousDraft.length < 10 ||
    correctedAnswer.length < 10 ||
    question.length > 1000 ||
    previousDraft.length > 4000 ||
    correctedAnswer.length > 4000 ||
    containsResidualPersonalData(combined) ||
    sensitiveTopic.test(combined) ||
    likelySecret.test(combined) ||
    directPersonalization.test(combined) ||
    likelyNamedGreeting.test(combined) ||
    nonReusableSupportText.test(combined) ||
    canonicalText(previousDraft) === canonicalText(correctedAnswer)
  ) {
    return undefined
  }
  return { question, previousDraft, correctedAnswer }
}

function contentHash(
  row: CandidateRow,
  source: AutomaticLearningSourceIds,
  route: { tenant: TenantKey; channel: SupportChannel },
  previousDraft: string,
  history: readonly SupportBrainHistoryTurn[],
): string | null {
  const questionCreatedAt = dateIso(row.question_created_at)
  const draftCreatedAt = dateIso(row.draft_created_at)
  const answerCreatedAt = dateIso(row.answer_created_at)
  if (!questionCreatedAt || !draftCreatedAt || !answerCreatedAt) return null
  return createHash('sha256')
    .update(
      JSON.stringify([
        'myinvest-automatic-learning-source/v2',
        source,
        route,
        {
          question: row.question,
          draftNote: row.draft_note,
          previousDraft,
          correctedAnswer: row.corrected_answer,
          questionCreatedAt,
          draftCreatedAt,
          answerCreatedAt,
          conversationTenant: row.conversation_tenant,
          conversationChannel: row.conversation_channel,
          sourceTenant: row.source_tenant,
        },
        history,
      ]),
    )
    .digest('hex')
}

function sourceFromRow(row: CandidateRow): AutomaticLearningSource | undefined {
  const source = automaticLearningSourceIdsSchema.safeParse({
    accountId: id(row.account_id),
    inboxId: id(row.inbox_id),
    conversationId: id(row.conversation_display_id),
    questionMessageId: id(row.question_message_id),
    draftMessageId: id(row.draft_message_id),
    answerMessageId: id(row.answer_message_id),
  })
  const fallbackTenant = tenantKeySchema.safeParse(row.default_tenant)
  if (!source.success || !fallbackTenant.success) return undefined
  const route = resolveSupportRoute(
    {
      conversationTenant: row.conversation_tenant,
      conversationChannel: row.conversation_channel,
      sourceTenant: row.source_tenant,
    },
    { tenant: fallbackTenant.data, channel: 'web' },
  )
  if (!route || ![0, 1, 2].includes(Number(row.answer_status))) {
    return undefined
  }
  const previousDraft = extractAgentDraft(row.draft_note)
  if (!previousDraft) return undefined
  const text = reusableText({
    question: row.question,
    previousDraft,
    correctedAnswer: row.corrected_answer,
  })
  if (!text) return undefined
  const history = safeHistory(row.history)
  const hash = contentHash(row, source.data, route, previousDraft, history)
  if (!hash) return undefined
  return {
    tenant: route.tenant,
    channel: route.channel,
    source: source.data,
    contentHash: hash,
    ...text,
    history,
  }
}

function configuredTenants(tenants: TenantRegistry) {
  return tenants.all.filter(
    (
      tenant,
    ): tenant is typeof tenant & {
      agentBotId: number
    } => tenant.agentBotId !== undefined,
  )
}

export async function discoverAutomaticLearningSources(
  database: ChatwootLearningQueryable,
  tenants: TenantRegistry,
  options: DiscoverAutomaticLearningSourcesOptions = {},
): Promise<AutomaticLearningDiscovery> {
  const limit = z.number().int().min(1).max(100).parse(options.limit ?? 50)
  const desiredTenant = options.tenant
    ? tenantKeySchema.parse(options.tenant)
    : undefined
  const cursor = options.cursor
    ? automaticLearningCursorSchema.parse(options.cursor)
    : undefined
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_automatic_learning_time')
  const configured = configuredTenants(tenants)
  if (configured.length === 0) return { sources: [] }
  const scanLimit = Math.min(500, limit * 5)
  const result = await database.query<CandidateRow>(DISCOVER_SQL, [
    configured.map((tenant) => tenant.accountId),
    configured.map((tenant) => tenant.inboxId),
    configured.map((tenant) => tenant.agentBotId),
    configured.map((tenant) => tenant.key),
    new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    now.toISOString(),
    cursor?.answeredAt ?? null,
    cursor?.answerMessageId ?? null,
    scanLimit + 1,
    desiredTenant ?? null,
  ])
  const rows = result.rows.slice(0, scanLimit)
  const sources: AutomaticLearningSource[] = []
  let processed = 0
  for (const row of rows) {
    processed += 1
    const source = sourceFromRow(row)
    if (source && (!desiredTenant || source.tenant === desiredTenant)) {
      sources.push(source)
    }
    if (sources.length === limit) break
  }
  const more = processed < rows.length || result.rows.length > scanLimit
  const last = rows[processed - 1]
  const answeredAt = last ? dateIso(last.answer_created_at) : null
  const answerMessageId = last ? id(last.answer_message_id) : null
  return {
    sources,
    ...(more && answeredAt && answerMessageId
      ? { nextCursor: { answeredAt, answerMessageId } }
      : {}),
  }
}

export async function resolveAutomaticLearningSource(
  database: ChatwootLearningQueryable,
  tenants: TenantRegistry,
  input: {
    source: AutomaticLearningSourceIds
    contentHash: string
  },
): Promise<AutomaticLearningSource> {
  const source = automaticLearningSourceIdsSchema.parse(input.source)
  const expectedHash = z.string().regex(/^[0-9a-f]{64}$/).parse(input.contentHash)
  const tenant = tenants.all.find(
    (candidate) =>
      candidate.accountId === source.accountId &&
      candidate.inboxId === source.inboxId,
  )
  if (!tenant) throw new Error('automatic_learning_source_not_found')
  if (!tenant.agentBotId) {
    throw new Error('automatic_learning_source_identity_unavailable')
  }
  const result = await database.query<CandidateRow>(RESOLVE_SQL, [
    tenant.accountId,
    tenant.inboxId,
    tenant.agentBotId,
    tenant.key,
    new Date().toISOString(),
    source.conversationId,
    source.questionMessageId,
    source.draftMessageId,
    source.answerMessageId,
  ])
  const resolved = result.rows[0] ? sourceFromRow(result.rows[0]) : undefined
  if (!resolved) throw new Error('automatic_learning_source_not_found')
  if (
    Object.keys(source).some(
      (key) =>
        source[key as keyof AutomaticLearningSourceIds] !==
        resolved.source[key as keyof AutomaticLearningSourceIds],
    )
  ) {
    throw new Error('automatic_learning_source_not_found')
  }
  if (resolved.contentHash !== expectedHash) {
    throw new Error('automatic_learning_source_changed')
  }
  return resolved
}
