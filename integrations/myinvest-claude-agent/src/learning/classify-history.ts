import type { TenantKey } from '../domain.js'
import {
  containsResidualPersonalData,
  directPersonalization,
  likelySecret,
  likelyNamedGreeting,
  nonReusableSupportText,
  sensitiveTopic,
} from './extractor.js'
import { rejectCandidate, type LearningPool } from './repository.js'

interface QueryResult<Row> {
  rows: Row[]
}

interface HistoryPool extends LearningPool {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

interface CandidateRow extends Record<string, unknown> {
  id: string
  question_redacted: string
  answer_redacted: string
}

export async function classifyHistoryCandidates(
  pool: HistoryPool,
  assignments: Readonly<Record<string, TenantKey>>,
): Promise<{ classified: number; rejected: number }> {
  let classified = 0
  let rejected = 0
  for (const [exportId, tenant] of Object.entries(assignments)) {
    const candidates = await pool.query<CandidateRow>(
      `SELECT id::text, question_redacted, answer_redacted
         FROM agent_knowledge_candidates
        WHERE source_export_id = $1
          AND source_namespace = 'hubspot-conversations-v3'
          AND status = 'quarantined'
        ORDER BY id`,
      [exportId],
    )
    for (const candidate of candidates.rows) {
      const combined = `${candidate.question_redacted} ${candidate.answer_redacted}`
      if (
        sensitiveTopic.test(combined) ||
        likelySecret.test(combined) ||
        likelyNamedGreeting.test(combined) ||
        directPersonalization.test(combined) ||
        nonReusableSupportText.test(combined) ||
        containsResidualPersonalData(combined)
      ) {
        await rejectCandidate(pool, candidate.id, 'history-safety-filter')
        rejected += 1
      }
    }

    const result = await pool.query<{ classified: number } & Record<string, unknown>>(
      `WITH updated AS (
         UPDATE agent_knowledge_candidates
            SET target_tenant = $2,
                risk_flags = array_append(
                  array_remove(risk_flags, 'unclassified_hubspot_history'),
                  'tenant_classified_history'
                ),
                updated_at = now()
          WHERE source_export_id = $1
            AND source_namespace = 'hubspot-conversations-v3'
            AND target_tenant IS NULL
            AND status = 'quarantined'
         RETURNING id
       ), audited AS (
         INSERT INTO agent_learning_audit_events
           (candidate_id, tenant_key, action, actor, details)
         SELECT id, $2, 'quarantined', 'history-tenant-classifier',
                jsonb_build_object('source_export_id', $1, 'tenant_classified', true)
           FROM updated
         RETURNING 1
       )
       SELECT count(*)::int AS classified FROM audited`,
      [exportId, tenant],
    )
    classified += result.rows[0]?.classified ?? 0
  }
  return { classified, rejected }
}
