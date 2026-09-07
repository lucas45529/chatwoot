import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { ChatwootPort } from './chatwoot-client.js'
import type { ChatwootConversationContextStore } from './chatwoot-delivery-repository.js'
import type { TenantConfig, TenantRegistry } from './config.js'
import type { ConversationContext } from './domain.js'
import {
  containsResidualPersonalData,
  redactSupportText,
} from './learning/extractor.js'
import {
  privateLearningReferences,
  type SupportBrainAnswer,
  type SupportBrainHistoryTurn,
  type SupportBrainPort,
} from './support-brain.js'

export const manualDraftRequestSchema = z.object({
  action: z.literal('draft'),
  accountId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  conversationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

export type ManualDraftStatus =
  | 'ready'
  | 'existing'
  | 'preserved'
  | 'already_answered'
  | 'unavailable'

export interface ManualDraftResult {
  status: ManualDraftStatus
}

export interface ManualDraftInput {
  accountId: number
  conversationId: number
}

interface QueryResult<Row> {
  rows: Row[]
}

export interface ManualDraftDatabase {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

/** Drafts live in Chatwoot's Redis store, not in the read-only Postgres view. */
export interface ManualDraftReader {
  loadDraft(tenant: TenantConfig, conversationId: number): Promise<string | undefined>
}

export const proposalSchema = z.object({
  sourceMessageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  draft: z.string().min(1).max(4_000),
  note: z.string().min(1).max(40_000),
}).strict()

export type ManualDraftProposal = z.infer<typeof proposalSchema>

export interface ManualDraftProposalStore {
  load(key: string): Promise<ManualDraftProposal | undefined>
  save(key: string, proposal: ManualDraftProposal): Promise<void>
  clear(key: string): Promise<void>
}

export interface ManualDraftDependencies {
  database: ManualDraftDatabase
  context: ChatwootConversationContextStore
  brain: SupportBrainPort
  drafts: ManualDraftReader
  proposals: ManualDraftProposalStore
  chatwoot: Pick<ChatwootPort, 'saveDraft' | 'sendPrivateNote'>
  tenants: TenantRegistry
  pseudonymizationKey: string
  whatsappInboxIds: ReadonlySet<number>
}

interface ManualDraftSourceRow extends Record<string, unknown> {
  conversation_id: string
  inbox_id: number
  source_message_id: string | null
  source_content: string | null
  source_content_type: number | null
  human_replied_after_inbound: boolean
  draft_note_exists: boolean
}

const ATTACHMENT_REVIEW_DRAFT =
  'Danke für den Anhang. Was genau sollen wir darin prüfen, und an welcher Stelle tritt das Problem auf?'
const EMPTY_MESSAGE_REVIEW_DRAFT =
  'Bitte beschreibe kurz dein Anliegen und an welcher Stelle das Problem auftritt.'

const ATTACHMENT_PLACEHOLDER = /^\(audio-nachricht ohne text\)$/iu
const MANUAL_REVIEW_REQUEST_DOMAIN = 'manual-review'

export class ManualDraftService {
  constructor(private readonly dependencies: ManualDraftDependencies) {}

  async createDraft(
    input: ManualDraftInput,
    signal?: AbortSignal,
  ): Promise<ManualDraftResult> {
    signal?.throwIfAborted()
    if (!isPositiveSafeInteger(input.accountId) || !isPositiveSafeInteger(input.conversationId)) {
      return { status: 'unavailable' }
    }

    let tenant: TenantConfig
    try {
      tenant = this.dependencies.tenants.requireByAccountId(input.accountId)
    } catch {
      return { status: 'unavailable' }
    }

    try {
      const source = await this.loadSource(tenant, input.conversationId)
      if (!source || source.inbox_id !== tenant.inboxId) {
        return { status: 'unavailable' }
      }
      const sourceMessageId = Number(source.source_message_id)
      if (!isPositiveSafeInteger(sourceMessageId)) {
        return { status: 'unavailable' }
      }
      const proposalKey = manualDraftProposalKey(
        tenant,
        input.conversationId,
      )
      const [currentDraft, pendingProposal] = await Promise.all([
        this.dependencies.drafts.loadDraft(tenant, input.conversationId),
        this.dependencies.proposals.load(proposalKey),
      ])
      const hasCurrentDraft = typeof currentDraft === 'string' && currentDraft.trim().length > 0
      if (pendingProposal) {
        return await this.resumeProposal({
          tenant,
          conversationId: input.conversationId,
          source,
          proposalKey,
          proposal: pendingProposal,
          currentDraft,
          signal,
        })
      }
      if (source.human_replied_after_inbound) {
        return { status: 'already_answered' }
      }
      if (source.draft_note_exists) {
        return { status: hasCurrentDraft ? 'existing' : 'unavailable' }
      }
      if (hasCurrentDraft) return { status: 'preserved' }

      const context = await this.dependencies.context.loadContext({
        accountId: tenant.accountId,
        conversationDisplayId: input.conversationId,
        currentMessageId: sourceMessageId,
      })
      if (!context) return { status: 'unavailable' }

      const answer = await this.answerForSource({
        tenant,
        source,
        sourceMessageId,
        context,
        signal,
      })
      signal?.throwIfAborted()
      if (!answer) return { status: 'unavailable' }

      const currentSource = await this.loadSource(tenant, input.conversationId)
      const currentState = sourceState(currentSource, tenant, sourceMessageId)
      if (currentState !== 'current') return { status: currentState }
      if (currentSource!.draft_note_exists) {
        const sourceLinkedDraft = await this.dependencies.drafts.loadDraft(
          tenant,
          input.conversationId,
        )
        return {
          status:
            typeof sourceLinkedDraft === 'string' && sourceLinkedDraft.trim().length > 0
              ? 'existing'
              : 'unavailable',
        }
      }

      const proposal = proposalSchema.parse({
        sourceMessageId,
        draft: answer.text,
        note: draftNote(answer, tenant),
      })
      signal?.throwIfAborted()
      await this.dependencies.proposals.save(proposalKey, proposal)

      signal?.throwIfAborted()
      const draftWrite = await this.dependencies.chatwoot.saveDraft(
        tenant,
        input.conversationId,
        proposal.draft,
      )
      if (!draftWrite.written && draftWrite.message !== proposal.draft) {
        signal?.throwIfAborted()
        await this.dependencies.proposals.clear(proposalKey)
        return { status: 'preserved' }
      }
      return await this.finishProposal({
        tenant,
        conversationId: input.conversationId,
        sourceMessageId,
        proposalKey,
        proposal,
        readyStatus: draftWrite.written ? 'ready' : 'existing',
        signal,
      })
    } catch {
      return { status: 'unavailable' }
    }
  }

  private async resumeProposal(input: {
    tenant: TenantConfig
    conversationId: number
    source: ManualDraftSourceRow
    proposalKey: string
    proposal: ManualDraftProposal
    currentDraft: string | undefined
    signal?: AbortSignal
  }): Promise<ManualDraftResult> {
    const pendingState = sourceState(
      input.source,
      input.tenant,
      input.proposal.sourceMessageId,
    )
    if (pendingState !== 'current') {
      const rollback = await this.dependencies.chatwoot.saveDraft(
        input.tenant,
        input.conversationId,
        '',
        input.proposal.draft,
      )
      if (rollback.written) {
        await this.dependencies.proposals.clear(input.proposalKey)
      }
      return { status: pendingState }
    }
    if (input.source.draft_note_exists) {
      input.signal?.throwIfAborted()
      await this.dependencies.proposals.clear(input.proposalKey)
      return {
        status:
          typeof input.currentDraft === 'string' && input.currentDraft.trim().length > 0
            ? 'existing'
            : 'unavailable',
      }
    }
    if (input.currentDraft && input.currentDraft !== input.proposal.draft) {
      input.signal?.throwIfAborted()
      await this.dependencies.proposals.clear(input.proposalKey)
      return { status: 'preserved' }
    }

    let readyStatus: 'ready' | 'existing' = 'existing'
    if (input.currentDraft !== input.proposal.draft) {
      const currentSource = await this.loadSource(input.tenant, input.conversationId)
      const currentState = sourceState(
        currentSource,
        input.tenant,
        input.proposal.sourceMessageId,
      )
      if (currentState !== 'current') {
        input.signal?.throwIfAborted()
        await this.dependencies.proposals.clear(input.proposalKey)
        return { status: currentState }
      }
      input.signal?.throwIfAborted()
      const draftWrite = await this.dependencies.chatwoot.saveDraft(
        input.tenant,
        input.conversationId,
        input.proposal.draft,
      )
      if (!draftWrite.written && draftWrite.message !== input.proposal.draft) {
        input.signal?.throwIfAborted()
        await this.dependencies.proposals.clear(input.proposalKey)
        return { status: 'preserved' }
      }
      readyStatus = draftWrite.written ? 'ready' : 'existing'
    }
    return await this.finishProposal({
      ...input,
      sourceMessageId: input.proposal.sourceMessageId,
      readyStatus,
    })
  }

  private async finishProposal(input: {
    tenant: TenantConfig
    conversationId: number
    sourceMessageId: number
    proposalKey: string
    proposal: ManualDraftProposal
    readyStatus: 'ready' | 'existing'
    signal?: AbortSignal
  }): Promise<ManualDraftResult> {
    const currentSource = await this.loadSource(input.tenant, input.conversationId)
    const currentState = sourceState(currentSource, input.tenant, input.sourceMessageId)
    if (currentState !== 'current') {
      const rollback = await this.dependencies.chatwoot.saveDraft(
        input.tenant,
        input.conversationId,
        '',
        input.proposal.draft,
      )
      if (rollback.written) {
        await this.dependencies.proposals.clear(input.proposalKey)
      }
      return { status: currentState }
    }

    if (!currentSource!.draft_note_exists) {
      input.signal?.throwIfAborted()
      await this.dependencies.chatwoot.sendPrivateNote(
        input.tenant,
        input.conversationId,
        input.proposal.note,
        input.sourceMessageId,
        'draft_note',
      )
    }
    input.signal?.throwIfAborted()
    await this.dependencies.proposals.clear(input.proposalKey)
    return { status: input.readyStatus }
  }

  private async loadSource(
    tenant: TenantConfig,
    conversationId: number,
  ): Promise<ManualDraftSourceRow | undefined> {
    const result = await this.dependencies.database.query<ManualDraftSourceRow>(
      `SELECT conversation.id::text AS conversation_id,
              conversation.inbox_id,
              incoming.id::text AS source_message_id,
              incoming.content AS source_content,
              incoming.content_type AS source_content_type,
              COALESCE(
                (last_human.created_at, last_human.id) >
                (incoming.created_at, incoming.id),
                false
              ) AS human_replied_after_inbound,
              EXISTS(
                SELECT 1
                  FROM messages AS draft_note
                 WHERE draft_note.account_id = $1
                   AND draft_note.conversation_id = conversation.id
                   AND draft_note.private = true
                   AND CASE WHEN json_typeof(draft_note.content_attributes) = 'string'
                            THEN (draft_note.content_attributes #>> '{}')::json ->> 'myinvest_agent_delivery_id'
                            ELSE draft_note.content_attributes ->> 'myinvest_agent_delivery_id' END = incoming.id::text
                   AND CASE WHEN json_typeof(draft_note.content_attributes) = 'string'
                            THEN (draft_note.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
                            ELSE draft_note.content_attributes ->> 'myinvest_agent_message_kind' END = 'draft_note'
              ) AS draft_note_exists
         FROM conversations AS conversation
         LEFT JOIN LATERAL (
           SELECT message.id, message.content, message.content_type, message.created_at
             FROM messages AS message
            WHERE message.account_id = $1
              AND message.conversation_id = conversation.id
              AND message.private = false
              AND message.message_type = 0
              AND (message.sender_type IS NULL OR message.sender_type = 'Contact')
            ORDER BY message.created_at DESC, message.id DESC
            LIMIT 1
         ) AS incoming ON true
         LEFT JOIN LATERAL (
           SELECT message.id, message.created_at
             FROM messages AS message
            WHERE message.account_id = $1
              AND message.conversation_id = conversation.id
              AND message.private = false
              AND message.message_type = 1
              AND (
                message.sender_type = 'User'
                OR (
                  message.sender_type IS NULL
                  AND CASE WHEN json_typeof(message.content_attributes) = 'string'
                           THEN (message.content_attributes #>> '{}')::json ->> 'external_echo'
                           ELSE message.content_attributes ->> 'external_echo' END IS NOT NULL
                )
              )
              AND NOT (message.additional_attributes ? 'campaign_id')
              AND CASE WHEN json_typeof(message.content_attributes) = 'string'
                       THEN (message.content_attributes #>> '{}')::json ->> 'automation_rule_id'
                       ELSE message.content_attributes ->> 'automation_rule_id' END IS NULL
            ORDER BY message.created_at DESC, message.id DESC
            LIMIT 1
         ) AS last_human ON true
        WHERE conversation.account_id = $1
          AND conversation.display_id = $2
          AND conversation.inbox_id = $3`,
      [tenant.accountId, conversationId, tenant.inboxId],
    )
    return result.rows[0]
  }

  private async answerForSource(input: {
    tenant: TenantConfig
    source: ManualDraftSourceRow
    sourceMessageId: number
    context: ConversationContext
    signal?: AbortSignal
  }): Promise<SupportBrainAnswer | undefined> {
    const rawQuestion = input.source.source_content?.trim() ?? ''
    if (ATTACHMENT_PLACEHOLDER.test(rawQuestion)) {
      return {
        action: 'clarify',
        text: ATTACHMENT_REVIEW_DRAFT,
        confidence: 0,
        sources: [],
        safeToAutoSend: false,
        reason: 'attachment_without_text',
      }
    }
    if (!rawQuestion) {
      return {
        action: 'clarify',
        text: EMPTY_MESSAGE_REVIEW_DRAFT,
        confidence: 0,
        sources: [],
        safeToAutoSend: false,
        reason: 'message_without_text',
      }
    }

    const question = redactSupportText(rawQuestion).text.trim()
    if (!question || containsResidualPersonalData(question)) return undefined
    input.signal?.throwIfAborted()
    return this.dependencies.brain.answer({
      requestId: manualReviewRequestId(
        this.dependencies.pseudonymizationKey,
        input.tenant.accountId,
        input.sourceMessageId,
      ),
      question,
      history: input.context.turns.map(
        (turn): SupportBrainHistoryTurn => ({
          role: turn.role === 'customer' ? 'user' : 'agent',
          text: turn.text,
        }),
      ),
      tenant: input.tenant.key,
      channel: this.dependencies.whatsappInboxIds.has(input.tenant.inboxId)
        ? 'whatsapp'
        : 'web',
      ...(input.context.contactEmail
        ? { contact: { email: input.context.contactEmail } }
        : {}),
      reviewOnly: true,
    }, input.signal)
  }
}

export function manualDraftProposalKey(
  tenant: TenantConfig,
  conversationId: number,
): string {
  return `manual-draft:v1:${tenant.key}:${tenant.accountId}:${conversationId}`
}

export function manualReviewRequestId(
  pseudonymizationKey: string,
  accountId: number,
  messageId: number,
): string {
  const digest = createHmac('sha256', pseudonymizationKey)
    .update(`${MANUAL_REVIEW_REQUEST_DOMAIN}\0${accountId}\0${messageId}`)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sourceState(
  source: ManualDraftSourceRow | undefined,
  tenant: TenantConfig,
  expectedMessageId: number,
): 'current' | 'already_answered' | 'unavailable' {
  if (
    !source ||
    source.inbox_id !== tenant.inboxId ||
    Number(source.source_message_id) !== expectedMessageId
  ) {
    return 'unavailable'
  }
  return source.human_replied_after_inbound ? 'already_answered' : 'current'
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function draftNote(answer: SupportBrainAnswer, tenant: TenantConfig): string {
  const sourceNote = answer.sources.length > 0
    ? `\nQuellen: ${brainSources(answer)}`
    : '\nGrundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.'
  return (
    `KI-Antwortentwurf wartet auf menschliche Freigabe (manual_review).` +
    `\n\nAntwortvorschlag:\n${answer.text}${sourceNote}` +
    privateLearningReferences(answer, tenant.key)
  )
}

function brainSources(answer: SupportBrainAnswer): string {
  const references: string[] = []
  for (const source of answer.sources) {
    const reference = `${source.title} (${source.url})`
    if (!references.includes(reference)) references.push(reference)
  }
  return references.join(', ') || 'keine'
}
