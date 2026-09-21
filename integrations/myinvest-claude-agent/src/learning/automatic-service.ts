import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { TenantKey } from '../domain.js'
import type { LearningPool } from './repository.js'
import { LearningRequestError } from './review-auth.js'
import {
  automaticLearningEvaluationSchema,
  automaticLearningProposalSchema,
  automaticLearningSourceIdsSchema,
  type AutomaticLearningCommand,
  type AutomaticLearningEvaluation,
  type AutomaticLearningProposal,
  type AutomaticLearningSourceIds,
} from './automatic-schema.js'
import type { AutomaticLearningCursor, AutomaticLearningDiscovery, AutomaticLearningSource } from './automatic-source.js'
import { cleanInput } from './review-service.js'
import { likelyNamedGreeting, nonReusableSupportText } from './extractor.js'

export const AUTOMATIC_LEARNING_ACTOR = 'automatic-support-learning'
export const AUTOMATIC_LEARNING_NAMESPACE = 'automatic-support-learning-v1'
export const AUTOMATIC_LEARNING_CURSOR_NAMESPACE = 'automatic-support-learning-cursor-v1'
const LEASE_MS = 5 * 60 * 1_000
const MAX_RETRIES = 3

type Client = Awaited<ReturnType<LearningPool['connect']>>

export interface AutomaticLearningSourceProvider {
  discover(tenant: TenantKey, cursor?: AutomaticLearningCursor): Promise<AutomaticLearningDiscovery>
  resolve(input: { source: AutomaticLearningSourceIds; contentHash: string }): Promise<AutomaticLearningSource>
}

interface CandidateRow extends Record<string, unknown> {
  id: string
  tenant: TenantKey
  question: string
  answer: string
  status: string
  reviewed_by: string | null
  published_document_id: string | null
  content_hash: string
  provenance: unknown
  last_evaluation: unknown
  last_evaluation_id: string | null
}

const historySchema = z.array(z.object({ role: z.enum(['user', 'agent']), text: z.string().min(1).max(1500) }).strict()).max(12)
const provenanceSchema = z.object({
  kind: z.literal('automatic_source'),
  source: automaticLearningSourceIdsSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  question: z.string().min(8).max(1000),
  previousDraft: z.string().min(10).max(4000),
  correctedAnswer: z.string().min(10).max(4000),
  history: historySchema.optional(),
  channel: z.enum(['web', 'whatsapp']),
}).strict()

const evaluationAuditSchema = z.object({
  kind: z.literal('automatic_evaluation'),
  proposal: automaticLearningProposalSchema,
  evaluation: automaticLearningEvaluationSchema,
}).passthrough()

async function transaction<T>(pool: LearningPool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function audit(client: Client, candidateId: string, tenant: TenantKey, action: string, details: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO agent_learning_audit_events (candidate_id, tenant_key, action, actor, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [candidateId, tenant, action, AUTOMATIC_LEARNING_ACTOR, details],
  )
}

function sourceKey(source: AutomaticLearningSourceIds): string {
  return createHash('sha256').update([
    source.accountId, source.inboxId, source.conversationId,
    source.questionMessageId, source.draftMessageId, source.answerMessageId,
  ].join(':')).digest('hex')
}

export function automaticProposalHash(proposal: AutomaticLearningProposal): string {
  return createHash('sha256').update([
    proposal.question, proposal.answer, proposal.similarQuestion, proposal.reason,
  ].join('\0')).digest('hex')
}

function cleanSource(source: AutomaticLearningSource): z.infer<typeof provenanceSchema> {
  const question = cleanInput(source.question).text
  const previousDraft = cleanInput(source.previousDraft).text
  const correctedAnswer = cleanInput(source.correctedAnswer).text
  const history = source.history.map((turn) => ({ role: turn.role, text: cleanInput(turn.text).text }))
  return provenanceSchema.parse({
    kind: 'automatic_source', source: source.source, contentHash: source.contentHash,
    question, previousDraft, correctedAnswer, ...(history.length ? { history } : {}), channel: source.channel,
  })
}

function cleanProposal(proposal: AutomaticLearningProposal): AutomaticLearningProposal {
  const cleaned = automaticLearningProposalSchema.parse({
    question: cleanInput(proposal.question).text,
    answer: cleanInput(proposal.answer).text,
    similarQuestion: cleanInput(proposal.similarQuestion).text,
    reason: cleanInput(proposal.reason).text,
  })
  const combined = `${cleaned.question} ${cleaned.answer} ${cleaned.similarQuestion} ${cleaned.reason}`
  if (nonReusableSupportText.test(combined) || likelyNamedGreeting.test(combined)) {
    throw new LearningRequestError(422, 'non_reusable_learning_content')
  }
  return cleaned
}

function cleanEvaluation(evaluation: AutomaticLearningEvaluation): AutomaticLearningEvaluation {
  return automaticLearningEvaluationSchema.parse(evaluation)
}

export function assertAutomaticLearningEvaluation(evaluation: AutomaticLearningEvaluation, proposal: AutomaticLearningProposal, sourceHash: string): void {
  if (!evaluation.passed || evaluation.rejectionReasons.length > 0) throw new LearningRequestError(422, 'automatic_evaluation_failed')
  if (!evaluation.groundedProposal) throw new LearningRequestError(422, 'automatic_evaluation_not_grounded')
  if (evaluation.sourceContentHash !== sourceHash || evaluation.proposalHash !== automaticProposalHash(proposal)) {
    throw new LearningRequestError(409, 'automatic_evaluation_version_mismatch')
  }
  const ids = new Set(evaluation.judgments.map(({ pairId }) => pairId))
  if (ids.size !== 4) throw new LearningRequestError(422, 'automatic_evaluation_incomplete')
  for (const judgment of evaluation.judgments) {
    const { baseline, candidate } = judgment
    if (candidate.unsafe || candidate.criticalError || candidate.factualCorrectness < 3 || candidate.contextCorrectness < 3) {
      throw new LearningRequestError(422, 'automatic_evaluation_failed')
    }
    if (candidate.factualCorrectness < baseline.factualCorrectness ||
        candidate.contextCorrectness < baseline.contextCorrectness ||
        candidate.humanTone < baseline.humanTone) {
      throw new LearningRequestError(422, 'automatic_evaluation_regression')
    }
    if ((judgment.pairId === 'target' || judgment.pairId === 'variant') &&
        candidate.factualCorrectness === baseline.factualCorrectness &&
        candidate.contextCorrectness === baseline.contextCorrectness &&
        candidate.humanTone === baseline.humanTone) {
      throw new LearningRequestError(422, 'automatic_evaluation_no_improvement')
    }
  }
}

function claimResult(row: CandidateRow, leaseId: string, mode: 'learn' | 'recheck') {
  const provenance = provenanceSchema.parse(row.provenance)
  const evaluated = evaluationAuditSchema.safeParse(row.last_evaluation)
  if (mode === 'recheck' && !evaluated.success) throw new Error('Automatic recheck provenance unavailable')
  return {
    status: 'claimed' as const,
    id: row.id,
    tenant: row.tenant,
    leaseId,
    contentHash: provenance.contentHash,
    mode,
    source: provenance.source,
    question: provenance.question,
    previousDraft: provenance.previousDraft,
    correctedAnswer: provenance.correctedAnswer,
    ...(provenance.history ? { history: provenance.history } : {}),
    channel: provenance.channel,
    ...(evaluated.success ? { example: evaluated.data.proposal } : {}),
  }
}

export class AutomaticLearningService {
  constructor(private readonly pool: LearningPool, private readonly sources: AutomaticLearningSourceProvider) {}

  async execute(command: AutomaticLearningCommand): Promise<unknown> {
    if (command.operation === 'status') return this.status(command.tenant)
    if (command.operation === 'claim') return this.claim(command.tenant)
    return this.complete(command)
  }

  private async claim(tenant: TenantKey): Promise<unknown> {
    const stored = await this.claimStored(tenant)
    if (stored) return stored
    let cursor = await this.loadCursor(tenant)
    for (let page = 0; page < 4; page += 1) {
      const discovery = await this.sources.discover(tenant, cursor)
      for (const source of discovery.sources) {
        let provenance: z.infer<typeof provenanceSchema>
        try { provenance = cleanSource(source) } catch (error) {
          if (error instanceof LearningRequestError) continue
          throw error
        }
        const claimed = await this.createAndClaim(tenant, provenance)
        if (claimed) return claimed
      }
      if (!discovery.nextCursor) {
        await this.saveCursor(tenant, undefined)
        break
      }
      cursor = discovery.nextCursor
      await this.saveCursor(tenant, cursor)
    }
    return { status: 'idle' as const }
  }

  private async loadCursor(tenant: TenantKey): Promise<AutomaticLearningCursor | undefined> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<{ details: Record<string, unknown> }>(`SELECT a.details
        FROM agent_learning_audit_events a WHERE a.tenant_key = $1 AND a.actor = $2
          AND a.details->>'kind' = 'automatic_cursor' ORDER BY a.id DESC LIMIT 1`,
      [tenant, AUTOMATIC_LEARNING_ACTOR])
      const value = result.rows[0]?.details?.cursor
      if (!value || typeof value !== 'object') return undefined
      const cursor = value as Record<string, unknown>
      if (typeof cursor.answeredAt !== 'string' || typeof cursor.answerMessageId !== 'number') return undefined
      return { answeredAt: cursor.answeredAt, answerMessageId: cursor.answerMessageId }
    } finally { client.release() }
  }

  private async saveCursor(tenant: TenantKey, cursor: AutomaticLearningCursor | undefined): Promise<void> {
    await transaction(this.pool, async (client) => {
      const candidateKey = createHash('sha256').update(`${AUTOMATIC_LEARNING_CURSOR_NAMESPACE}\0${tenant}`).digest('hex')
      const anchor = await client.query<{ id: string }>(`INSERT INTO agent_knowledge_candidates
          (candidate_key, source_namespace, source_export_id, source_conversation_digest, target_tenant,
           question_redacted, answer_redacted, content_hash, redaction_count, risk_flags, status, redaction_version)
        VALUES ($1, $2, $3, $1, $3, 'Interner Cursor für automatisches Lernen',
          'Nicht als Lernbeispiel verwendbar.', $1, 0, '{internal_cursor}', 'quarantined', 3)
        ON CONFLICT (candidate_key) DO UPDATE SET updated_at = agent_knowledge_candidates.updated_at
        RETURNING id::text`, [candidateKey, AUTOMATIC_LEARNING_CURSOR_NAMESPACE, tenant])
      const anchorId = anchor.rows[0]?.id
      if (!anchorId) throw new Error('Automatic learning cursor anchor unavailable')
      await audit(client, anchorId, tenant, 'feedback_recorded', { kind: 'automatic_cursor', cursor: cursor ?? null })
    })
  }

  private async claimStored(tenant: TenantKey): Promise<unknown | undefined> {
    return transaction(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('automatic-support-learning:' || $1))`, [tenant])
      if (await this.hasActiveLease(client, tenant)) return { status: 'busy' as const }
      const selected = await client.query<CandidateRow>(`SELECT c.id::text, c.target_tenant AS tenant,
          c.question_redacted AS question, c.answer_redacted AS answer, c.status, c.reviewed_by,
          c.published_document_id::text, c.content_hash,
          (SELECT a.details FROM agent_learning_audit_events a
             WHERE a.candidate_id = c.id AND a.tenant_key = c.target_tenant AND a.actor = $2
               AND a.action = 'feedback_recorded' AND a.details->>'kind' = 'automatic_source'
             ORDER BY a.id DESC LIMIT 1) AS provenance,
          latest_evaluation.details AS last_evaluation,
          latest_evaluation.id AS last_evaluation_id
        FROM agent_knowledge_candidates c
        LEFT JOIN LATERAL (SELECT a.id::text, a.details, a.created_at
          FROM agent_learning_audit_events a WHERE a.candidate_id = c.id
            AND a.tenant_key = c.target_tenant AND a.actor = $2 AND a.action = 'published'
            AND a.details->>'kind' = 'automatic_evaluation' ORDER BY a.id DESC LIMIT 1) latest_evaluation ON true
        WHERE c.target_tenant = $1
          AND EXISTS (SELECT 1 FROM agent_learning_audit_events p WHERE p.candidate_id = c.id AND p.actor = $2 AND p.details->>'kind' = 'automatic_source')
          AND ((c.status = 'pending_review' AND c.reviewed_by IS NULL AND NOT EXISTS (
                 SELECT 1 FROM agent_learning_audit_events r WHERE r.candidate_id = c.id AND r.actor = $2
                   AND r.details->>'kind' = 'automatic_retry'
                   AND r.details->>'cycleId' = 'learn:' || c.id::text
                   AND (r.details->>'retryAfter')::timestamptz > now()))
            OR (c.status = 'published' AND c.reviewed_by = $2 AND latest_evaluation.id IS NOT NULL
              AND latest_evaluation.created_at <= now() - interval '7 days'
              AND NOT EXISTS (SELECT 1 FROM agent_learning_audit_events r WHERE r.candidate_id = c.id AND r.actor = $2
                AND r.details->>'kind' = 'automatic_retry'
                AND r.details->>'cycleId' = 'recheck:' || latest_evaluation.id
                AND (r.details->>'retryAfter')::timestamptz > now())))
        ORDER BY CASE WHEN c.status = 'published' THEN 0 ELSE 1 END,
          coalesce(latest_evaluation.created_at, c.created_at), c.id
        FOR UPDATE OF c SKIP LOCKED LIMIT 1`, [tenant, AUTOMATIC_LEARNING_ACTOR])
      const row = selected.rows[0]
      if (!row) return undefined
      return this.lease(client, row, row.status === 'published' ? 'recheck' : 'learn')
    })
  }

  private async createAndClaim(tenant: TenantKey, provenance: z.infer<typeof provenanceSchema>): Promise<unknown | undefined> {
    return transaction(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('automatic-support-learning:' || $1))`, [tenant])
      if (await this.hasActiveLease(client, tenant)) return { status: 'busy' as const }
      const exportId = sourceKey(provenance.source)
      const previous = await client.query<CandidateRow>(`SELECT c.id::text, c.status, c.reviewed_by, c.content_hash,
          c.target_tenant AS tenant, c.question_redacted AS question, c.answer_redacted AS answer,
          c.published_document_id::text, NULL::jsonb AS provenance, NULL::jsonb AS last_evaluation,
          NULL::text AS last_evaluation_id
        FROM agent_knowledge_candidates c
        WHERE c.source_namespace = $1 AND c.source_export_id = $2 AND c.target_tenant = $3
        ORDER BY c.id DESC FOR UPDATE`, [AUTOMATIC_LEARNING_NAMESPACE, exportId, tenant])
      if (previous.rows.length > 0) return undefined
      const candidateKey = createHash('sha256').update(`${AUTOMATIC_LEARNING_NAMESPACE}\0${tenant}\0${exportId}\0${provenance.contentHash}`).digest('hex')
      const inserted = await client.query<CandidateRow>(`INSERT INTO agent_knowledge_candidates
          (candidate_key, source_namespace, source_export_id, source_conversation_digest, target_tenant,
           question_redacted, answer_redacted, content_hash, redaction_count, risk_flags, status, redaction_version)
        VALUES ($1, $2, $3, $3, $4, $5, $6, $7, 0, '{}', 'pending_review', 3)
        ON CONFLICT (candidate_key) DO NOTHING
        RETURNING id::text, target_tenant AS tenant, question_redacted AS question, answer_redacted AS answer,
          status, reviewed_by, published_document_id::text, content_hash`,
      [candidateKey, AUTOMATIC_LEARNING_NAMESPACE, exportId, tenant, provenance.question, provenance.correctedAnswer, provenance.contentHash])
      const row = inserted.rows[0]
      if (!row) return undefined
      await audit(client, row.id, tenant, 'feedback_recorded', provenance)
      row.provenance = provenance
      row.last_evaluation = null
      row.last_evaluation_id = null
      return this.lease(client, row, 'learn')
    })
  }

  private async hasActiveLease(client: Client, tenant: TenantKey): Promise<boolean> {
    const active = await client.query<{ active: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM agent_learning_audit_events lease
        WHERE lease.tenant_key = $1 AND lease.actor = $2 AND lease.action = 'feedback_recorded'
          AND lease.details->>'kind' = 'automatic_lease'
          AND (lease.details->>'expiresAt')::timestamptz > now()
          AND NOT EXISTS (SELECT 1 FROM agent_learning_audit_events done
            WHERE done.candidate_id = lease.candidate_id AND done.actor = $2 AND done.id > lease.id
              AND done.details->>'leaseId' = lease.details->>'leaseId'
              AND done.details->>'kind' IN ('automatic_evaluation', 'automatic_rejected', 'automatic_retry'))
      ) AS active`, [tenant, AUTOMATIC_LEARNING_ACTOR])
    return active.rows[0]?.active === true
  }

  private async lease(client: Client, row: CandidateRow, mode: 'learn' | 'recheck') {
    const leaseId = randomUUID()
    const provenance = provenanceSchema.parse(row.provenance)
    const cycleId = mode === 'learn' ? `learn:${row.id}` : row.last_evaluation_id ? `recheck:${row.last_evaluation_id}` : undefined
    if (!cycleId) throw new Error('Automatic recheck cycle unavailable')
    await audit(client, row.id, row.tenant, 'feedback_recorded', {
      kind: 'automatic_lease', leaseId, cycleId, contentHash: provenance.contentHash, mode,
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    })
    return claimResult(row, leaseId, mode)
  }

  private async complete(command: Extract<AutomaticLearningCommand, { operation: 'complete' }>): Promise<unknown> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<CandidateRow>(`SELECT c.id::text, c.target_tenant AS tenant,
          c.question_redacted AS question, c.answer_redacted AS answer, c.status, c.reviewed_by,
          c.published_document_id::text, c.content_hash,
          (SELECT a.details FROM agent_learning_audit_events a WHERE a.candidate_id = c.id AND a.actor = $3
             AND a.details->>'kind' = 'automatic_source' ORDER BY a.id DESC LIMIT 1) AS provenance,
          (SELECT a.details FROM agent_learning_audit_events a WHERE a.candidate_id = c.id AND a.actor = $3
             AND a.action = 'published' AND a.details->>'kind' = 'automatic_evaluation' ORDER BY a.id DESC LIMIT 1) AS last_evaluation,
          (SELECT a.id::text FROM agent_learning_audit_events a WHERE a.candidate_id = c.id AND a.actor = $3
             AND a.action = 'published' AND a.details->>'kind' = 'automatic_evaluation' ORDER BY a.id DESC LIMIT 1) AS last_evaluation_id
        FROM agent_knowledge_candidates c WHERE c.id = $1 AND c.target_tenant = $2 FOR UPDATE`,
      [command.id, command.tenant, AUTOMATIC_LEARNING_ACTOR])
      const candidate = locked.rows[0]
      if (!candidate) throw new LearningRequestError(404, 'candidate_not_found')
      const provenance = provenanceSchema.safeParse(candidate.provenance)
      if (!provenance.success) throw new LearningRequestError(409, 'automatic_provenance_missing')
      const lease = await client.query<{ details: Record<string, unknown> }>(`SELECT details FROM agent_learning_audit_events
        WHERE candidate_id = $1 AND tenant_key = $2 AND actor = $3 AND action = 'feedback_recorded'
          AND details->>'kind' = 'automatic_lease'
          AND NOT EXISTS (SELECT 1 FROM agent_learning_audit_events done
            WHERE done.candidate_id = agent_learning_audit_events.candidate_id AND done.actor = $3
              AND done.id > agent_learning_audit_events.id
              AND done.details->>'leaseId' = agent_learning_audit_events.details->>'leaseId'
              AND done.details->>'kind' IN ('automatic_evaluation', 'automatic_rejected', 'automatic_retry'))
        ORDER BY id DESC LIMIT 1`,
      [command.id, command.tenant, AUTOMATIC_LEARNING_ACTOR])
      const details = lease.rows[0]?.details
      if (!details || details.leaseId !== command.leaseId || details.contentHash !== command.contentHash ||
          typeof details.cycleId !== 'string' || typeof details.expiresAt !== 'string' || Date.parse(details.expiresAt) <= Date.now()) {
        throw new LearningRequestError(409, 'automatic_lease_expired')
      }
      if (provenance.data.contentHash !== command.contentHash ||
          !['pending_review', 'published'].includes(candidate.status) ||
          (candidate.status === 'published' && candidate.reviewed_by !== AUTOMATIC_LEARNING_ACTOR)) {
        throw new LearningRequestError(409, 'automatic_candidate_changed')
      }
      if ((candidate.status === 'published' ? 'recheck' : 'learn') !== details.mode) {
        throw new LearningRequestError(409, 'automatic_candidate_changed')
      }
      let current: AutomaticLearningSource
      try {
        current = await this.sources.resolve({ source: provenance.data.source, contentHash: command.contentHash })
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (['automatic_learning_source_not_found', 'automatic_learning_source_identity_unavailable', 'automatic_learning_source_changed'].includes(code)) {
          await this.reject(client, candidate, command.tenant, command.leaseId, code)
          return { status: 'rejected' as const, id: candidate.id }
        }
        throw error
      }
      const currentSource = cleanSource(current)
      if (current.tenant !== command.tenant || JSON.stringify(currentSource) !== JSON.stringify(provenance.data)) {
        await this.reject(client, candidate, command.tenant, command.leaseId, 'automatic_learning_source_changed')
        return { status: 'rejected' as const, id: candidate.id }
      }

      if (command.outcome === 'retry') {
        const attempts = await client.query<{ count: string }>(`SELECT coalesce(max((details->>'attempt')::int), 0)::text AS count
          FROM agent_learning_audit_events WHERE candidate_id = $1 AND tenant_key = $2 AND actor = $3
            AND details->>'kind' = 'automatic_retry' AND details->>'cycleId' = $4`,
        [candidate.id, command.tenant, AUTOMATIC_LEARNING_ACTOR, details.cycleId])
        const attempt = Number(attempts.rows[0]?.count ?? 0) + 1
        if (attempt >= MAX_RETRIES) {
          await this.reject(client, candidate, command.tenant, command.leaseId, 'retry_limit_reached')
          return { status: 'rejected' as const, id: candidate.id }
        }
        await audit(client, candidate.id, command.tenant, 'feedback_recorded', {
          kind: 'automatic_retry', leaseId: command.leaseId, cycleId: details.cycleId, attempt,
          retryAfter: new Date(Date.now() + 2 ** attempt * 15 * 60 * 1_000).toISOString(),
          reason: cleanInput(command.reason).text,
        })
        return { status: 'retry' as const, id: candidate.id }
      }
      if (command.outcome === 'reject') {
        await this.reject(client, candidate, command.tenant, command.leaseId, cleanInput(command.reason).text)
        return { status: 'rejected' as const, id: candidate.id }
      }
      if (!command.proposal || !command.evaluation) throw new LearningRequestError(422, 'automatic_evaluation_required')
      const proposal = cleanProposal(command.proposal)
      const evaluation = cleanEvaluation(command.evaluation)
      assertAutomaticLearningEvaluation(evaluation, proposal, command.contentHash)
      const proposalHash = automaticProposalHash(proposal)
      const auditDetails = {
        kind: 'automatic_evaluation', leaseId: command.leaseId, sourceContentHash: command.contentHash,
        proposalHash, proposal, evaluation, reason: cleanInput(command.reason).text,
      }
      if (candidate.status === 'published') {
        if (candidate.question !== proposal.question || candidate.answer !== proposal.answer || candidate.content_hash !== proposalHash) {
          throw new LearningRequestError(409, 'automatic_recheck_version_mismatch')
        }
        await client.query(`UPDATE agent_knowledge_candidates SET reviewed_at = now(), updated_at = now()
          WHERE id = $1 AND target_tenant = $2 AND reviewed_by = $3`, [candidate.id, command.tenant, AUTOMATIC_LEARNING_ACTOR])
        await audit(client, candidate.id, command.tenant, 'published', { ...auditDetails, recheck: true })
        return { status: 'published' as const, id: candidate.id }
      }
      await client.query(`UPDATE agent_knowledge_candidates SET question_redacted = $3, answer_redacted = $4,
          content_hash = $5, redaction_count = $6, status = 'approved', reviewed_by = $7,
          reviewed_at = now(), updated_at = now() WHERE id = $1 AND target_tenant = $2 AND status = 'pending_review'`,
      [candidate.id, command.tenant, proposal.question, proposal.answer, proposalHash,
        cleanInput(proposal.question).redactionCount + cleanInput(proposal.answer).redactionCount, AUTOMATIC_LEARNING_ACTOR])
      await audit(client, candidate.id, command.tenant, 'approved', auditDetails)
      const document = await client.query<{ id: string }>(`INSERT INTO agent_knowledge_documents
          (tenant_key, source_namespace, source_id, title, content, metadata, content_hash,
           publication_status, active, learning_candidate_id)
        VALUES ($1, 'reviewed-automatic-support', 'candidate:' || $2, 'Geprüfte Support-Antwort',
          'Frage: ' || $3 || E'\n\nAntwort: ' || $4, '{"review":"automatic-evaluated"}'::jsonb,
          $5, 'published', true, $2::bigint) RETURNING id::text`,
      [command.tenant, candidate.id, proposal.question, proposal.answer, proposalHash])
      if (!document.rows[0]) throw new Error('Automatic learning document insert failed')
      await client.query(`UPDATE agent_knowledge_candidates SET status = 'published', published_document_id = $3,
          published_at = now(), updated_at = now() WHERE id = $1 AND target_tenant = $2 AND status = 'approved'`,
      [candidate.id, command.tenant, document.rows[0].id])
      await audit(client, candidate.id, command.tenant, 'published', auditDetails)
      return { status: 'published' as const, id: candidate.id }
    })
  }

  private async reject(client: Client, candidate: CandidateRow, tenant: TenantKey, leaseId: string, reason: string): Promise<void> {
    await client.query(`UPDATE agent_knowledge_candidates SET status = 'rejected', published_document_id = NULL,
      published_at = NULL, reviewed_by = $3, reviewed_at = now(), updated_at = now()
      WHERE id = $1 AND target_tenant = $2 AND status IN ('pending_review', 'published')`,
    [candidate.id, tenant, AUTOMATIC_LEARNING_ACTOR])
    if (candidate.published_document_id) {
      await client.query(`UPDATE agent_knowledge_documents SET active = false, publication_status = 'retired',
        learning_candidate_id = NULL, updated_at = now()
        WHERE id = $1 AND tenant_key = $2 AND learning_candidate_id = $3`,
      [candidate.published_document_id, tenant, candidate.id])
    }
    await audit(client, candidate.id, tenant, 'rejected', { kind: 'automatic_rejected', leaseId, reason })
  }

  private async status(tenant: TenantKey): Promise<unknown> {
    const client = await this.pool.connect()
    try {
      const counts = await client.query<{ pending: string; published: string; rejected: string; last_run: Date | string | null }>(`SELECT
          count(*) FILTER (WHERE c.status IN ('quarantined', 'pending_review', 'approved'))::text AS pending,
          count(*) FILTER (WHERE c.status = 'published')::text AS published,
          count(*) FILTER (WHERE c.status = 'rejected')::text AS rejected,
          (SELECT max(a.created_at) FROM agent_learning_audit_events a WHERE a.tenant_key = $1 AND a.actor = $2) AS last_run
        FROM agent_knowledge_candidates c WHERE c.target_tenant = $1 AND EXISTS (
          SELECT 1 FROM agent_learning_audit_events p WHERE p.candidate_id = c.id AND p.actor = $2 AND p.details->>'kind' = 'automatic_source')`,
      [tenant, AUTOMATIC_LEARNING_ACTOR])
      const topics = await client.query<{ question: string; count: string; status: 'pending' | 'published' | 'rejected'; reason: string }>(`SELECT topic.question, count(*)::text AS count, topic.status,
          (array_agg(topic.reason ORDER BY topic.updated_at DESC))[1] AS reason
        FROM (SELECT left(c.question_redacted, 1000) AS question,
            CASE WHEN c.status = 'published' THEN 'published' WHEN c.status = 'rejected' THEN 'rejected' ELSE 'pending' END AS status,
            left(coalesce((SELECT a.details->>'reason' FROM agent_learning_audit_events a
              WHERE a.candidate_id = c.id AND a.actor = $2 AND a.details ? 'reason' ORDER BY a.id DESC LIMIT 1), ''), 500) AS reason,
            c.updated_at
          FROM agent_knowledge_candidates c WHERE c.target_tenant = $1 AND c.status <> 'published' AND EXISTS (
            SELECT 1 FROM agent_learning_audit_events p WHERE p.candidate_id = c.id AND p.actor = $2 AND p.details->>'kind' = 'automatic_source')) topic
        GROUP BY topic.question, topic.status ORDER BY max(topic.updated_at) DESC LIMIT 10`,
      [tenant, AUTOMATIC_LEARNING_ACTOR])
      const summary = counts.rows[0]
      return {
        enabled: true,
        tenant,
        counts: { pending: Number(summary?.pending ?? 0), published: Number(summary?.published ?? 0), rejected: Number(summary?.rejected ?? 0) },
        lastRun: summary?.last_run ? new Date(summary.last_run).toISOString() : null,
        topics: topics.rows.map((topic) => ({ ...topic, count: Number(topic.count) })),
      }
    } finally { client.release() }
  }
}
