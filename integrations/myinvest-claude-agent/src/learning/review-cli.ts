import pg from 'pg'
import { approveCandidate, publishCandidate, rejectCandidate } from './repository.js'

const databaseUrl = process.env.DATABASE_URL || process.env.CLAUDE_AGENT_DATABASE_URL
const action = process.argv[2]
const candidateId = process.argv[3]
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const pool = new pg.Pool({ connectionString: databaseUrl })
try {
  if (action === 'list') {
    // Review-Warteschlange: neue zuerst; Approve/Publish per ID.
    const limit = Number(process.argv[3] ?? 20)
    const result = await pool.query(
      `SELECT id, status, target_tenant, source_namespace, created_at,
              left(question_redacted, 140) AS question, left(answer_redacted, 200) AS answer
         FROM agent_knowledge_candidates
        WHERE status IN ('quarantined', 'pending_review')
        ORDER BY id DESC
        LIMIT $1`,
      [Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 20],
    )
    console.log(JSON.stringify({ event: 'knowledge_candidates_pending', count: result.rows.length }))
    for (const row of result.rows) {
      console.log(`#${row.id} [${row.status}] tenant=${row.target_tenant ?? '?'} (${row.source_namespace})`)
      console.log(`  F: ${row.question}`)
      console.log(`  A: ${row.answer}`)
    }
  } else if (action === 'approve') {
    const tenant = process.argv[4]
    const actor = process.argv[5]
    if (!candidateId) throw new Error('Candidate ID required')
    if (!tenant || !actor) throw new Error('Usage: approve <candidate-id> <tenant> <reviewer>')
    await approveCandidate(pool, candidateId, tenant, actor)
    console.log(JSON.stringify({ event: 'knowledge_candidate_reviewed', action, candidate_id: candidateId }))
  } else if (action === 'publish') {
    const actor = process.argv[4]
    if (!candidateId) throw new Error('Candidate ID required')
    if (!actor) throw new Error('Usage: publish <candidate-id> <reviewer>')
    await publishCandidate(pool, candidateId, actor)
    console.log(JSON.stringify({ event: 'knowledge_candidate_reviewed', action, candidate_id: candidateId }))
  } else if (action === 'reject') {
    const actor = process.argv[4]
    if (!candidateId) throw new Error('Candidate ID required')
    if (!actor) throw new Error('Usage: reject <candidate-id> <reviewer>')
    await rejectCandidate(pool, candidateId, actor)
    console.log(JSON.stringify({ event: 'knowledge_candidate_reviewed', action, candidate_id: candidateId }))
  } else {
    throw new Error('Action required: list|approve|publish|reject')
  }
} finally {
  await pool.end()
}
