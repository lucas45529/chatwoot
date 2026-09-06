import { z } from 'zod'
import type { TenantRegistry } from '../config.js'
import type { TenantKey } from '../domain.js'
import { extractAgentDraft } from '../chatwoot-delivery-repository.js'
import { LearningRequestError } from './review-auth.js'

const sourceId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const learningSourceSchema = z.object({
  accountId: sourceId,
  conversationId: sourceId,
  questionMessageId: sourceId,
  draftMessageId: sourceId,
}).strict()
export type LearningSource = z.infer<typeof learningSourceSchema>
export interface ResolvedLearningSource {
  tenant: TenantKey
  source: LearningSource
  question: string
  previousDraft: string
}
export interface LearningSourceResolver {
  resolve(source: LearningSource): Promise<ResolvedLearningSource>
}
interface ReadonlyDatabase {
  query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<{ rows: Row[] }>
}

/** Only immutable Chatwoot records establish provenance. The browser supplies
 * IDs, never an authoritative question, original answer or tenant. The
 * configured bot ID avoids granting the runtime access to credential tables. */
export class PostgresLearningSourceResolver implements LearningSourceResolver {
  constructor(private readonly database: ReadonlyDatabase, private readonly tenants: TenantRegistry) {}

  async resolve(input: LearningSource): Promise<ResolvedLearningSource> {
    const parsed = learningSourceSchema.safeParse(input)
    if (!parsed.success) throw new LearningRequestError(422, 'invalid_learning_source')
    const source = parsed.data
    const tenant = this.tenants.all.find((entry) => entry.accountId === source.accountId)
    if (!tenant) throw new LearningRequestError(404, 'learning_source_not_found')
    if (!tenant.agentBotId) throw new LearningRequestError(503, 'learning_source_identity_unavailable')
    const result = await this.database.query<{ question: string; draft_note: string }>(`
      SELECT q.content AS question, n.content AS draft_note
      FROM conversations c
      JOIN messages q ON q.id = $3 AND q.conversation_id = c.id AND q.account_id = c.account_id
        AND q.inbox_id = c.inbox_id AND q.message_type = 0 AND q.private = false
        AND (q.sender_type IS NULL OR q.sender_type = 'Contact')
      JOIN messages n ON n.id = $4 AND n.conversation_id = c.id AND n.account_id = c.account_id
        AND n.inbox_id = c.inbox_id AND n.message_type = 1 AND n.private = true
        AND n.sender_type = 'AgentBot' AND n.sender_id = $5 AND n.id > q.id
      WHERE c.account_id = $1 AND c.display_id = $2 AND c.inbox_id = $6
        AND CASE WHEN json_typeof(n.content_attributes) = 'string'
          THEN (n.content_attributes #>> '{}')::json ->> 'myinvest_agent_delivery_id'
          ELSE n.content_attributes ->> 'myinvest_agent_delivery_id' END = q.id::text
        AND CASE WHEN json_typeof(n.content_attributes) = 'string'
          THEN (n.content_attributes #>> '{}')::json ->> 'myinvest_agent_message_kind'
          ELSE n.content_attributes ->> 'myinvest_agent_message_kind' END
          IN ('draft_note', 'clarify_draft_note', 'handoff_note')
        AND NOT EXISTS (
          SELECT 1 FROM messages sent
          WHERE sent.account_id = c.account_id AND sent.conversation_id = c.id
            AND sent.inbox_id = c.inbox_id AND sent.id > q.id
            AND sent.message_type = 1 AND sent.private = false
        )
        AND NOT EXISTS (
          SELECT 1 FROM messages newer
          WHERE newer.account_id = c.account_id AND newer.conversation_id = c.id
            AND newer.inbox_id = c.inbox_id AND newer.id > q.id
            AND newer.message_type = 0 AND newer.private = false
        )
      LIMIT 1`, [source.accountId, source.conversationId, source.questionMessageId, source.draftMessageId, tenant.agentBotId, tenant.inboxId])
    const row = result.rows[0]
    if (!row) throw new LearningRequestError(404, 'learning_source_not_found')
    const question = typeof row.question === 'string' ? row.question.trim() : ''
    const previousDraft = extractAgentDraft(row.draft_note)
    if (question.length < 8 || question.length > 1000 || !previousDraft || previousDraft.length < 10 || previousDraft.length > 4000) {
      throw new LearningRequestError(422, 'learning_source_not_supported')
    }
    return { tenant: tenant.key, source, question, previousDraft }
  }
}
