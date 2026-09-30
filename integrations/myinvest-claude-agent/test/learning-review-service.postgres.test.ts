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
      status text, reviewed_by text, updated_at timestamptz,
      source_namespace text NOT NULL DEFAULT 'approved-manual'
    )`)
    await client.query(`CREATE TEMP TABLE agent_learning_audit_events (
      id bigint, candidate_id bigint, action text, details jsonb,
      tenant_key text DEFAULT 'saas', actor text DEFAULT 'intern-support-review'
    )`)
    await client.query(`INSERT INTO agent_knowledge_candidates
      (id, target_tenant, question_redacted, answer_redacted, status, reviewed_by, updated_at)
      SELECT id, 'saas', 'Wie bearbeite ich Kontakte?', 'Öffne Kontakte und wähle Bearbeiten.',
        'rejected', 'intern-support-review', now() FROM generate_series(1, 3) id`)
    await client.query(`INSERT INTO agent_knowledge_candidates
      (id, target_tenant, status, updated_at, source_namespace)
      VALUES (4, 'saas', 'rejected', now(), 'automatic-support-learning-cursor-v1')`)
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

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('scores the most relevant examples even when 300 newer loose matches exist', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE TEMP TABLE agent_knowledge_candidates (
      id bigint, target_tenant text, question_redacted text, answer_redacted text,
      status text, reviewed_by text, updated_at timestamptz, published_at timestamptz,
      published_document_id bigint, content_hash text,
      source_namespace text NOT NULL DEFAULT 'approved-manual'
    )`)
    await client.query(`CREATE TEMP TABLE agent_knowledge_documents (
      id bigint, learning_candidate_id bigint, tenant_key text, active boolean,
      publication_status text, content_hash text
    )`)
    await client.query(`CREATE TEMP TABLE agent_learning_audit_events (
      id bigserial, candidate_id bigint, action text, details jsonb,
      tenant_key text DEFAULT 'saas', actor text DEFAULT 'intern-support-review'
    )`)
    // One old exact match, then 301 newer examples that only share one word.
    await client.query(`INSERT INTO agent_knowledge_candidates
      (id, target_tenant, question_redacted, answer_redacted, status, reviewed_by, updated_at, published_at, published_document_id, content_hash)
      VALUES (1, 'saas', 'Wie exportiere ich die Kontaktliste als Tabelle?',
        'Öffne Kontakte, wähle Export und lade die Tabelle herunter.', 'published',
        'intern-support-review', now() - interval '90 days', now() - interval '90 days', 1, 'h1')`)
    await client.query(`INSERT INTO agent_knowledge_candidates
      (id, target_tenant, question_redacted, answer_redacted, status, reviewed_by, updated_at, published_at, published_document_id, content_hash)
      SELECT id, 'saas', 'Wie exportiere ich Rechnungsbelege Nummer ' || id || '?',
        'Die Belege findest du im Bereich Abrechnung.', 'published', 'intern-support-review',
        now() - (id || ' minutes')::interval, now() - (id || ' minutes')::interval, id, 'h' || id
      FROM generate_series(2, 302) id`)
    await client.query(`INSERT INTO agent_knowledge_documents
      SELECT id, id, 'saas', true, 'published', 'h' || id FROM generate_series(1, 302) id`)
    await client.query(`INSERT INTO agent_learning_audit_events (candidate_id, action, details)
      SELECT id, 'published', '{}'::jsonb FROM generate_series(1, 302) id`)
    const service = new LearningReviewService({ connect: async () => ({
      query: (sql, values) => client.query(sql, values ? [...values] : undefined),
      release() {},
    }) })
    await expect(service.execute({
      action: 'retrieve',
      tenant: 'saas',
      question: 'Wie exportiere ich die Kontaktliste als Tabelle?',
    })).resolves.toMatchObject({ examples: [{ id: '1' }] })
  } finally {
    await client.end()
  }
})
