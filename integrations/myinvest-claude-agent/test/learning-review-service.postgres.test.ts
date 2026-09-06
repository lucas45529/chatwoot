import { Client } from 'pg'
import { expect, it } from 'vitest'
import { LearningReviewService } from '../src/learning/review-service.js'

// Temporary tables shadow the production names only on this connection. No
// existing candidates or audit records are read or changed by this regression.
it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('keeps human correction text after withdrawal and supersession', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE agent_knowledge_candidates (
      id bigint, target_tenant text, question_redacted text, answer_redacted text,
      status text, reviewed_by text, updated_at timestamptz
    )`)
    await client.query(`CREATE TEMP TABLE agent_learning_audit_events (
      id bigint, candidate_id bigint, action text, details jsonb,
      tenant_key text DEFAULT 'saas', actor text DEFAULT 'intern-support-review'
    )`)
    await client.query(`INSERT INTO agent_knowledge_candidates
      SELECT id, 'saas', 'Wie bearbeite ich Kontakte?', 'Öffne Kontakte und wähle Bearbeiten.',
        'rejected', 'intern-support-review', now() FROM generate_series(1, 3) id`)
    await client.query(`INSERT INTO agent_learning_audit_events (id, candidate_id, action, details) VALUES
      (1, 1, 'feedback_recorded', '{"reason":"Der bisherige Knopf existiert nicht mehr."}'),
      (2, 1, 'rejected', '{"reason":"rejected_by_reviewer"}'),
      (3, 2, 'feedback_recorded', '{"reason":"Der Ablauf war unvollständig."}'),
      (4, 2, 'rejected', '{"reason":"superseded_by_correction"}'),
      (5, 3, 'rejected', '{"reason":"rejected_by_reviewer"}')`)
    const service = new LearningReviewService({ connect: async () => ({
      query: (sql, values) => client.query(sql, values ? [...values] : undefined),
      release() {},
    }) })
    await expect(service.execute({ action: 'list', tenant: 'saas' })).resolves.toMatchObject({
      candidates: [
        { id: '3', reason: '' },
        { id: '2', reason: 'Der Ablauf war unvollständig.' },
        { id: '1', reason: 'Der bisherige Knopf existiert nicht mehr.' },
      ],
    })
  } finally {
    await client.end()
  }
})
