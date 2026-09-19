import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { tenantKeySchema } from '../domain.js'
import { containsResidualPersonalData, directPersonalization, likelySecret, redactSupportText, sensitiveTopic } from './extractor.js'
import type { LearningPool } from './repository.js'
import { LearningRequestError } from './review-auth.js'
import { learningSourceSchema, type LearningSource, type LearningSourceResolver, type ResolvedLearningSource } from './source.js'

const historySchema = z.array(z.object({ role: z.enum(['user', 'agent']), text: z.string().min(1).max(1500) }).strict()).max(12)
const exampleSchema = z.object({ question: z.string().trim().min(8).max(1000), answer: z.string().trim().min(10).max(4000), reason: z.string().trim().min(3).max(1000) }).strict()
const id = z.string().regex(/^[1-9]\d{0,18}$/)
export const learningCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('source'), source: learningSourceSchema, includeContext: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal('list'), tenant: tenantKeySchema }).strict(),
  z.object({ action: z.literal('save'), tenant: tenantKeySchema, id: id.optional(), source: learningSourceSchema.optional(), correctedAnswer: z.string().trim().min(10).max(4000).optional(), question: z.string().trim().min(8).max(1000), answer: z.string().trim().min(10).max(4000), reason: z.string().trim().min(3).max(1000) }).strict(),
  z.object({ action: z.enum(['publish', 'reject']), tenant: tenantKeySchema, id }).strict(),
  z.object({ action: z.literal('retrieve'), tenant: tenantKeySchema, question: z.string().trim().min(1).max(1000), history: historySchema.optional() }).strict(),
  z.object({ action: z.literal('preview'), tenant: tenantKeySchema, question: z.string().trim().min(1).max(1000), history: historySchema.optional(), example: exampleSchema }).strict(),
])
export type LearningCommand = z.infer<typeof learningCommandSchema>

export interface ReviewCandidate extends Record<string, unknown> {
  id: string
  tenant: string
  question: string
  answer: string
  status: string
  reason: string
  updatedAt: string | Date
  source?: LearningSource
}
interface LockedCandidate extends ReviewCandidate {
  published_document_id: string | null
  reviewed_by: string | null
}
type Client = Awaited<ReturnType<LearningPool['connect']>>
const ACTOR = 'intern-support-review'
const COLUMNS = `c.id::text, c.target_tenant AS tenant, c.question_redacted AS question,
  c.answer_redacted AS answer, c.status, c.reviewed_by, c.updated_at AS "updatedAt",
  coalesce((SELECT details->>'reason' FROM agent_learning_audit_events a
    WHERE a.candidate_id = c.id AND a.action = 'feedback_recorded' AND a.details ? 'reason' ORDER BY a.id DESC LIMIT 1), '') AS reason,
  (SELECT details->'source' FROM agent_learning_audit_events a
    WHERE a.candidate_id = c.id AND a.tenant_key = c.target_tenant AND a.actor = 'intern-support-review'
      AND a.action = 'feedback_recorded' AND a.details ? 'source' ORDER BY a.id DESC LIMIT 1) AS source`

function present(row: ReviewCandidate): ReviewCandidate {
  const status = row.status === 'published' && row.reviewed_by !== ACTOR ? 'pending_review' : row.status
  const source = learningSourceSchema.safeParse(row.source)
  return { id: row.id, tenant: row.tenant, question: row.question, answer: row.answer, status, reason: row.reason, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt, ...(source.success ? { source: source.data } : {}) }
}

const STOP_WORDS = new Set('kunde kunden nennt nannte seine seiner sein ihre ihrer bereits obwohl per wäre würde dein deine hey hi gespräch gesprächskontext aktuell danke aber alle alles auch auf aus bei bin bitte das dass dem den der des die diese dieser doch du ein eine einem einen einer es etwas für habe haben hier ich im in ist kann kannst können machen man mein meine mich mir mit muss nach nicht noch nun oder schon sein sind so um und uns vom von vor wann warum was welche welcher welches wenn wer wie wird wir wo zu zum zur'.split(' '))
const TERM_ALIASES: Record<string, string> = {
  rufnummer: 'telefonnummer', telefon: 'telefonnummer', handynummer: 'telefonnummer',
  call: 'termin', videocall: 'termin', meeting: 'termin', gesprächstermin: 'termin',
  vereinbart: 'bestätigt', vereinbarter: 'bestätigt', vereinbarten: 'bestätigt', bestätigter: 'bestätigt', bestätigten: 'bestätigt',
}
function terms(question: string): string[] {
  return [...new Set((question.toLocaleLowerCase('de').normalize('NFC').match(/[\p{L}\p{N}]{3,40}/gu) ?? [])
    .filter((term) => !STOP_WORDS.has(term) && !/^\d+$/.test(term))
    .map((term) => TERM_ALIASES[term] ?? term))].slice(0, 80)
}
function searchTerms(question: string): string[] {
  const normalized = terms(question)
  return [...new Set([...normalized, ...Object.entries(TERM_ALIASES).filter(([, term]) => normalized.includes(term)).map(([alias]) => alias)])]
}

// Candidate coverage keeps a long conversation from diluting a precise situation.
// Short overlapping fragments (especially phone presence alone) cannot qualify.
export function matchReviewedExamples(question: string, rows: readonly ReviewCandidate[]): Array<{ id: string; question: string; answer: string }> {
  const queryTerms = terms(question)
  if (queryTerms.length < 2) return []
  return rows.filter((row) => {
    const candidate = terms(row.question)
    if (candidate.includes('bestätigt') && /\b(?:kein\w*|nicht)\b[^.!?]{0,50}\b(?:termin|call|vereinbart\w*|bestätigt\w*)\b/iu.test(question)) return false
    if (candidate.includes('termin') && /\b(?:absag\w*|stornier\w*|verschieb\w*)\b/iu.test(question) && !/\b(?:absag\w*|stornier\w*|verschieb\w*)\b/iu.test(row.question)) return false
    return true
  }).map((row) => {
    const candidateTerms = new Set(terms(row.question))
    const shared = queryTerms.filter((term) => candidateTerms.has(term)).length
    return { row, score: shared / candidateTerms.size, shared, candidateTerms }
  }).filter(({ score, shared, candidateTerms }) => shared >= 2 && score >= 0.75 &&
    !(shared < 3 && candidateTerms.size > 3) &&
    queryTerms.some((term) => candidateTerms.has(term) && !/^(?:telefon|telefonnummer|nummer|erhalten|gesendet|angegeben|kontakt|danke|vorhanden)$/.test(term)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3).map(({ row }) => ({ id: row.id, question: row.question, answer: row.answer }))
}

function retrievalQuestion(question: string, history?: Array<{ role: 'user' | 'agent'; text: string }>): string {
  if (!history?.length) return question.slice(0, 1000)
  const prefix = question.slice(0, 500) + '\nGesprächskontext:\n'
  return prefix + history.slice(-12).map((turn) => turn.text).join('\n').slice(-(1000 - prefix.length))
}

function sourceSnapshot(source: ResolvedLearningSource): Record<string, unknown> {
  const scrub = (text: string) => {
    const value = redactSupportText(text).text.replace(/\b(?:sk|pk|api|access|secret|token)[-_][a-z0-9_-]{12,}\b/giu, '[SECRET]')
    return containsResidualPersonalData(value) ? '[INHALT REDIGIERT]' : value
  }
  return {
    question: scrub(source.question), previousDraft: scrub(source.previousDraft),
    history: source.history.map((turn) => ({ role: turn.role, text: scrub(turn.text) })),
    ...(source.channel ? { channel: source.channel } : {}),
  }
}

async function audit(client: Client, candidate: string, tenant: string, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await client.query(`INSERT INTO agent_learning_audit_events (candidate_id, tenant_key, action, actor, details) VALUES ($1, $2, $3, $4, $5)`, [candidate, tenant, action, ACTOR, details])
}

async function retire(client: Client, candidate: LockedCandidate, reason: string): Promise<void> {
  if (candidate.status === 'rejected') return
  await client.query(`UPDATE agent_knowledge_candidates SET status = 'rejected', published_document_id = NULL, published_at = NULL, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1 AND target_tenant = $2`, [candidate.id, candidate.tenant, ACTOR])
  if (candidate.published_document_id) {
    await client.query(`UPDATE agent_knowledge_documents SET active = false, publication_status = 'retired', learning_candidate_id = NULL, updated_at = now() WHERE id = $1 AND tenant_key = $2 AND learning_candidate_id = $3`, [candidate.published_document_id, candidate.tenant, candidate.id])
  }
  await audit(client, candidate.id, candidate.tenant, 'rejected', { reason })
}

function cleanInput(value: string): { text: string; redactionCount: number } {
  const credentialAlias = /\b(?:passwords?|passcodes?|pins?|api[-_\s]*(?:keys?|schlüssel|schluessel)|(?:access|recovery|backup|verification|security)[-_\s]*(?:codes?|keys?|tokens?)|(?:zugangs|zugriffs|wiederherstellungs|sicherheits|verifizierungs|bestätigungs|bestaetigungs)codes?|(?:client|private|secret)[-_\s]*(?:keys?|secrets?))\b/iu
  if (likelySecret.test(value) || credentialAlias.test(value)) throw new LearningRequestError(422, 'credentials_not_allowed')
  // Reuse the miner's content perimeter for manual review too. Generic reset
  // navigation is reusable; an actual password or an individual entitlement
  // remains prohibited even when a reviewer attempts to publish it.
  const credentialText = value.replace(/[„“”"'«»‘’]/gu, '')
  if (/\b(?:passwort|kennwort)\s+(?:zurücksetzen|zuruecksetzen|ändern|aendern)\s*(?:(?:auf|zu)\b|[=:])/iu.test(credentialText)) {
    throw new LearningRequestError(422, 'credentials_not_allowed')
  }
  // Only a closed button label or generic reset instruction is exempt. Do
  // not erase the credential marker in "Passwort zurücksetzen auf <value>".
  const reusableProcessText = value.replace(/\b(?:passwort|kennwort)\s+(?:zurücksetzen|zuruecksetzen|ändern|aendern|vergessen)\b(?=\s*(?:$|[.!?„“”"'«»‘’]|und\s+(?:folge|befolge)\b))/giu, '')
  const individualGrant = /\b(?:leads?|gutschrift|rabatt|sonderkonditionen|zusatzleistungen)\b[^.!?\n]{0,100}\b(?:freigegeben|zugesagt|versprochen|bewilligt|gewährt|gewaehrt|reserviert)\b/iu
  if (sensitiveTopic.test(reusableProcessText) || directPersonalization.test(value) || individualGrant.test(value)) {
    throw new LearningRequestError(422, 'non_reusable_learning_content')
  }
  const clean = redactSupportText(value)
  if (containsResidualPersonalData(clean.text)) throw new LearningRequestError(422, 'personal_data_requires_removal')
  return clean
}

export class LearningReviewService {
  constructor(private readonly pool: LearningPool, private readonly sourceResolver?: LearningSourceResolver) {}

  private async resolveSource(source: LearningSource) {
    if (!this.sourceResolver) throw new LearningRequestError(503, 'learning_source_unavailable')
    return this.sourceResolver.resolve(source)
  }

  async execute(input: LearningCommand): Promise<unknown> {
    const parsed = learningCommandSchema.safeParse(input)
    if (!parsed.success) throw new LearningRequestError(422, 'invalid_learning_command')
    const command = parsed.data
    if (command.action === 'source') {
      const resolved = await this.resolveSource(command.source)
      if (command.includeContext) return resolved
      // Older website deployments validate the original response strictly.
      // The internal resolver still returns context for audit persistence.
      return { tenant: resolved.tenant, source: resolved.source, question: resolved.question, previousDraft: resolved.previousDraft }
    }
    let resolvedSource: ResolvedLearningSource | undefined
    if (command.action === 'save' && command.source && !command.id) {
      const resolved = await this.resolveSource(command.source)
      resolvedSource = resolved
      if (resolved.tenant !== command.tenant) throw new LearningRequestError(422, 'learning_source_tenant_mismatch')
    }
    const cleaned = command.action === 'save' ? {
      question: cleanInput(command.question), answer: cleanInput(command.answer), reason: cleanInput(command.reason).text, correctedAnswer: command.correctedAnswer ? cleanInput(command.correctedAnswer).text : undefined,
    } : undefined
    if (cleaned && (cleaned.question.text.length < 8 || cleaned.answer.text.length < 10 || cleaned.reason.length < 3)) throw new LearningRequestError(422, 'learning_text_too_short')
    let previewMatches: boolean | undefined
    let previewCandidate: { question: string; answer: string } | undefined
    if (command.action === 'preview') {
      const example = { question: cleanInput(command.example.question), answer: cleanInput(command.example.answer), reason: cleanInput(command.example.reason) }
      if (example.question.text.length < 8 || example.answer.text.length < 10 || example.reason.text.length < 3) throw new LearningRequestError(422, 'learning_text_too_short')
      previewCandidate = { question: example.question.text, answer: example.answer.text }
      // Evaluate exactly what a save and publication would make retrievable.
      previewMatches = matchReviewedExamples(retrievalQuestion(command.question, command.history), [{ id: 'preview', tenant: command.tenant, question: example.question.text, answer: example.answer.text, reason: '', status: 'preview', updatedAt: '' }]).length > 0
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      let result: unknown
      if (command.action === 'list') {
        const rows = await client.query<ReviewCandidate>(`SELECT ${COLUMNS} FROM agent_knowledge_candidates c WHERE c.target_tenant = $1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 100`, [command.tenant])
        result = { mode: 'review_required', candidates: rows.rows.map(present) }
      } else if (command.action === 'retrieve' || command.action === 'preview') {
        const query = retrievalQuestion(command.question, command.history)
        const queryTerms = terms(query)
        if (queryTerms.length < 2) result = { examples: [] }
        else {
          const rows = await client.query<ReviewCandidate>(`SELECT ${COLUMNS}
            FROM agent_knowledge_candidates c
            JOIN agent_knowledge_documents d ON d.id = c.published_document_id AND d.learning_candidate_id = c.id AND d.tenant_key = c.target_tenant
            WHERE c.target_tenant = $1 AND c.status = 'published'
              AND c.reviewed_by = 'intern-support-review'
              AND d.active = true AND d.publication_status = 'published'
              AND EXISTS (SELECT 1 FROM agent_learning_audit_events a WHERE a.candidate_id = c.id AND a.tenant_key = c.target_tenant AND a.actor = 'intern-support-review' AND a.action = 'published')
              AND regexp_split_to_array(lower(c.question_redacted), '[^[:alnum:]]+') && $2::text[]
            ORDER BY c.published_at DESC, c.id DESC LIMIT 300`, [command.tenant, searchTerms(query)])
          result = { examples: matchReviewedExamples(query, rows.rows) }
        }
        if (command.action === 'preview') result = { ...(result as { examples: unknown[] }), eligible: previewMatches, candidateMatches: previewMatches, ...(previewMatches ? { candidate: previewCandidate } : {}) }
      } else {
        let existing: LockedCandidate | undefined
        if (command.id) {
          const locked = await client.query<LockedCandidate>(`SELECT ${COLUMNS}, c.published_document_id::text FROM agent_knowledge_candidates c WHERE c.id = $1 AND c.target_tenant = $2 FOR UPDATE`, [command.id, command.tenant])
          existing = locked.rows[0]
          if (!existing) throw new LearningRequestError(404, 'candidate_not_found')
        }
        let candidateId = command.id
        if (command.action === 'save' && cleaned) {
          const storedSource = learningSourceSchema.safeParse(existing?.source)
          const source = command.source ?? (storedSource.success ? storedSource.data : undefined)
          // An existing audited example remains editable after the reply is
          // sent. Only unchanged, verified provenance inherits that trust.
          const inheritsSource = storedSource.success && source &&
            source.accountId === storedSource.data.accountId &&
            source.conversationId === storedSource.data.conversationId &&
            source.questionMessageId === storedSource.data.questionMessageId &&
            source.draftMessageId === storedSource.data.draftMessageId
          if (command.id && source && !inheritsSource) {
            const resolved = await this.resolveSource(source)
            resolvedSource = resolved
            if (resolved.tenant !== command.tenant) throw new LearningRequestError(422, 'learning_source_tenant_mismatch')
          }
          // Every edit creates a new ID, including pending drafts. An old tab
          // cannot publish text changed elsewhere: its old ID is rejected.
          if (existing) await retire(client, existing, 'superseded_by_correction')
          const hash = createHash('sha256').update(`${command.tenant}\0${cleaned.question.text}\0${cleaned.answer.text}`).digest('hex')
          const nonce = randomUUID()
          const key = createHash('sha256').update(`intern-support-review\0${nonce}`).digest('hex')
          const created = await client.query<{ id: string }>(`INSERT INTO agent_knowledge_candidates
            (candidate_key, source_namespace, source_export_id, source_conversation_digest, target_tenant, question_redacted, answer_redacted, content_hash, redaction_count, risk_flags, status, redaction_version)
            VALUES ($1, 'intern-support-review-v1', $2, $1, $3, $4, $5, $6, $7, '{}', 'pending_review', 3) RETURNING id::text`, [key, nonce, command.tenant, cleaned.question.text, cleaned.answer.text, hash, cleaned.question.redactionCount + cleaned.answer.redactionCount])
          candidateId = created.rows[0]?.id
          if (!candidateId) throw new Error('Learning candidate insert failed')
          await audit(client, candidateId, command.tenant, 'feedback_recorded', { reason: cleaned.reason, ...(resolvedSource ? { sourceContext: sourceSnapshot(resolvedSource) } : {}), ...(cleaned.correctedAnswer ? { correctedAnswer: cleaned.correctedAnswer } : {}), ...(source ? { source } : {}), ...(existing ? { previous_candidate_id: existing.id } : {}) })
        } else if (command.action === 'reject' && existing) {
          await retire(client, existing, 'rejected_by_reviewer')
        } else if (command.action === 'publish' && existing) {
          if (existing.status === 'rejected') throw new LearningRequestError(409, 'save_new_version_before_publication')
          const question = cleanInput(existing.question)
          const answer = cleanInput(existing.answer)
          if (question.text !== existing.question || answer.text !== existing.answer) throw new LearningRequestError(422, 'save_redacted_version_before_publication')
          if (existing.status !== 'published') {
            await client.query(`UPDATE agent_knowledge_candidates SET status = 'approved', reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1 AND target_tenant = $2`, [existing.id, command.tenant, ACTOR])
            await audit(client, existing.id, command.tenant, 'approved')
            const document = await client.query<{ id: string }>(`INSERT INTO agent_knowledge_documents
              (tenant_key, source_namespace, source_id, title, content, metadata, content_hash, publication_status, active, learning_candidate_id)
              SELECT target_tenant, 'reviewed-intern-support', 'candidate:' || candidate_key, 'Freigegebene Support-Antwort', 'Frage: ' || question_redacted || E'\n\nAntwort: ' || answer_redacted, '{"review":"human-approved"}'::jsonb, content_hash, 'published', true, id
              FROM agent_knowledge_candidates WHERE id = $1 AND target_tenant = $2 RETURNING id::text`, [existing.id, command.tenant])
            if (!document.rows[0]) throw new Error('Learning document insert failed')
            await client.query(`UPDATE agent_knowledge_candidates SET status = 'published', published_document_id = $3, published_at = now(), updated_at = now() WHERE id = $1 AND target_tenant = $2`, [existing.id, command.tenant, document.rows[0].id])
          } else {
            // Explicitly re-review historical auto-published entries without
            // duplicating their document or bypassing the transition trigger.
            await client.query(`UPDATE agent_knowledge_candidates SET reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1 AND target_tenant = $2`, [existing.id, command.tenant, ACTOR])
            await audit(client, existing.id, command.tenant, 'approved', { rereview: true })
          }
          await audit(client, existing.id, command.tenant, 'published')
        }
        const saved = await client.query<ReviewCandidate>(`SELECT ${COLUMNS} FROM agent_knowledge_candidates c WHERE c.id = $1 AND c.target_tenant = $2`, [candidateId, command.tenant])
        if (!saved.rows[0]) throw new Error('Learning candidate result unavailable')
        result = { candidate: present(saved.rows[0]) }
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
