import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { automaticProposalHash, AutomaticLearningService } from '../src/learning/automatic-service.js'
import type { AutomaticLearningSource } from '../src/learning/automatic-source.js'

const source: AutomaticLearningSource = {
  tenant: 'saas', channel: 'web',
  source: { accountId: 1, inboxId: 2, conversationId: 3, questionMessageId: 4, draftMessageId: 5, answerMessageId: 6 },
  contentHash: 'a'.repeat(64),
  question: 'Wie bearbeite ich einen bestehenden Kontakt?',
  previousDraft: 'Öffne die Übersicht und wähle den Kontakt aus.',
  correctedAnswer: 'Öffne Kontakte, wähle den Eintrag und danach Bearbeiten.',
  history: [],
}
const proposal = {
  question: 'Wie bearbeite ich einen bestehenden Kontakt?',
  answer: 'Öffne Kontakte, wähle den Eintrag und danach Bearbeiten.',
  similarQuestion: 'Wo kann ich die Angaben eines Kontakts ändern?',
  reason: 'Der Ablauf nennt den richtigen Einstieg.',
}
const score = { factualCorrectness: 3, contextCorrectness: 3, humanTone: 3, unsafe: false, criticalError: false }
const evaluation = {
  schemaVersion: 1 as const, model: 'gemini-3.8-flash', promptVersion: 'automatic-learning-v1', brainVersion: 'local',
  sourceContentHash: source.contentHash, proposalHash: automaticProposalHash(proposal), passed: true,
  groundedProposal: true,
  judgments: (['target', 'variant', 'heldout_benign', 'heldout_context_conflict'] as const).map((pairId) => ({
    pairId, baseline: { ...score, factualCorrectness: pairId === 'target' || pairId === 'variant' ? 2 : 3 },
    candidate: score, candidateWasA: true,
  })),
  rejectionReasons: [] as const, pairHashes: Array(4).fill('c'.repeat(64)),
}

async function applyLearningMigrations(pool: Pool, schema: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`SET search_path TO "${schema}"`)
    for (const migration of ['001_knowledge.sql', '002_learning.sql', '003_redaction_refresh.sql', '004_redaction_rereview.sql']) {
      await client.query(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
    }
  } finally {
    client.release()
  }
}

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('serializes claims, binds versions, and revokes a failed recheck', async () => {
  const schema = `automatic_learning_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: process.env.LEARNING_TEST_DATABASE_URL, max: 4 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  try {
    await applyLearningMigrations(admin, schema)
    const database = {
      async connect() {
        const client = await admin.connect()
        await client.query(`SET search_path TO "${schema}"`)
        return client
      },
    }
    let availableSource = source
    let resolvedSource = source
    const sources = {
      discover: async () => ({ sources: [availableSource] }),
      resolve: async () => resolvedSource,
    }
    const first = new AutomaticLearningService(database, sources)
    const second = new AutomaticLearningService(database, sources)
    const claims = await Promise.all([
      first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }),
      second.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }),
    ]) as Array<Record<string, unknown>>
    const claimed = claims.find(({ status }) => status === 'claimed')
    expect(claims.map(({ status }) => status).sort()).toEqual(['busy', 'claimed'])
    expect(claimed).toBeDefined()
    const completion = {
      action: 'automatic' as const, operation: 'complete' as const, tenant: 'saas' as const,
      id: claimed!.id as string, leaseId: claimed!.leaseId as string, contentHash: source.contentHash,
      outcome: 'publish' as const, proposal, evaluation, reason: 'Alle Prüfpaar-Grenzen bestanden.',
    }
    await expect(first.execute(completion)).resolves.toEqual({ status: 'published', id: claimed!.id })
    await expect(first.execute(completion)).rejects.toMatchObject({ status: 409 })

    const backlogSource = { ...source, source: { ...source.source, answerMessageId: 70 }, contentHash: 'b'.repeat(64) }
    availableSource = backlogSource
    resolvedSource = backlogSource
    const backlog = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    expect(backlog).toMatchObject({ status: 'claimed', mode: 'learn' })
    await expect(first.execute({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: backlog.id as string,
      leaseId: backlog.leaseId as string, contentHash: backlogSource.contentHash,
      outcome: 'retry', reason: 'Backlog wartet auf einen neuen Versuch.',
    })).resolves.toEqual({ status: 'retry', id: backlog.id })
    await admin.query(`UPDATE "${schema}".agent_learning_audit_events
      SET details = jsonb_set(details, '{retryAfter}', to_jsonb((now() - interval '1 minute')::text))
      WHERE details->>'kind' = 'automatic_retry'`)
    await admin.query(`UPDATE "${schema}".agent_learning_audit_events SET created_at = now() - interval '8 days'
      WHERE action = 'published' AND actor = 'automatic-support-learning'`)
    availableSource = source
    resolvedSource = source
    let recheck = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    expect(recheck).toMatchObject({ status: 'claimed', mode: 'recheck', example: proposal })
    await expect(first.execute({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: recheck.id as string,
      leaseId: recheck.leaseId as string, contentHash: source.contentHash,
      outcome: 'retry', reason: 'Temporärer Modellfehler.',
    })).resolves.toEqual({ status: 'retry', id: claimed!.id })
    resolvedSource = backlogSource
    const fairBacklog = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    expect(fairBacklog).toMatchObject({ status: 'claimed', mode: 'learn', id: backlog.id })
    await expect(first.execute({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: fairBacklog.id as string,
      leaseId: fairBacklog.leaseId as string, contentHash: backlogSource.contentHash,
      outcome: 'reject', reason: 'Backlog-Test abgeschlossen.',
    })).resolves.toEqual({ status: 'rejected', id: backlog.id })
    resolvedSource = source
    await expect(first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' })).resolves.toEqual({ status: 'idle' })
    await admin.query(`UPDATE "${schema}".agent_learning_audit_events
      SET details = jsonb_set(details, '{retryAfter}', to_jsonb((now() - interval '1 minute')::text))
      WHERE details->>'kind' = 'automatic_retry'`)
    recheck = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    await expect(first.execute({ ...completion, leaseId: recheck.leaseId as string })).resolves.toEqual({ status: 'published', id: claimed!.id })
    await admin.query(`UPDATE "${schema}".agent_learning_audit_events SET created_at = now() - interval '8 days'
      WHERE action = 'published' AND actor = 'automatic-support-learning'`)
    recheck = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    await expect(first.execute({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: recheck.id as string,
      leaseId: recheck.leaseId as string, contentHash: source.contentHash,
      outcome: 'retry', reason: 'Noch ein temporärer Modellfehler.',
    })).resolves.toEqual({ status: 'retry', id: claimed!.id })
    const retry = await admin.query(`SELECT details FROM "${schema}".agent_learning_audit_events
      WHERE details->>'kind' = 'automatic_retry' ORDER BY id DESC LIMIT 1`)
    expect(retry.rows[0]?.details).toMatchObject({ attempt: 1 })
    await admin.query(`UPDATE "${schema}".agent_learning_audit_events
      SET details = jsonb_set(details, '{retryAfter}', to_jsonb((now() - interval '1 minute')::text))
      WHERE details->>'kind' = 'automatic_retry'`)
    recheck = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    await expect(first.execute({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: recheck.id as string,
      leaseId: recheck.leaseId as string, contentHash: source.contentHash,
      outcome: 'reject', reason: 'Die erneute Prüfung ist fehlgeschlagen.',
    })).resolves.toEqual({ status: 'rejected', id: claimed!.id })
    const retired = await admin.query(`SELECT c.status, d.active, d.publication_status, d.learning_candidate_id
      FROM "${schema}".agent_knowledge_candidates c JOIN "${schema}".agent_knowledge_documents d ON d.id = 1
      WHERE c.id = $1`, [claimed!.id])
    expect(retired.rows[0]).toMatchObject({ status: 'rejected', active: false, publication_status: 'retired', learning_candidate_id: null })

    availableSource = { ...source, source: { ...source.source, answerMessageId: 7 } }
    resolvedSource = availableSource
    const driftClaim = await first.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' }) as Record<string, unknown>
    expect(driftClaim).toMatchObject({ status: 'claimed', mode: 'learn' })
    resolvedSource = { ...availableSource, history: [{ role: 'user', text: 'Ein nachträglich geänderter Kontext.' }] }
    await expect(first.execute({
      ...completion, id: driftClaim.id as string, leaseId: driftClaim.leaseId as string,
    })).resolves.toEqual({ status: 'rejected', id: driftClaim.id })
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('persists an invisible cursor anchor before any learnable candidate exists', async () => {
  const schema = `automatic_cursor_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: process.env.LEARNING_TEST_DATABASE_URL, max: 2 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  try {
    await applyLearningMigrations(admin, schema)
    const database = {
      async connect() {
        const client = await admin.connect()
        await client.query(`SET search_path TO "${schema}"`)
        return client
      },
    }
    const unsafe = (answerMessageId: number): AutomaticLearningSource => ({
      ...source, source: { ...source.source, answerMessageId },
      question: 'Was kostet dieser Vertrag für den Kunden?',
    })
    const discover = async (_tenant: string, cursor?: { answerMessageId: number }) => {
      const offset = cursor?.answerMessageId ?? 0
      if (offset >= 200) return { sources: [source] }
      return {
        sources: Array.from({ length: 50 }, (_, index) => unsafe(offset + index + 1)),
        nextCursor: { answeredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, offset / 50)).toISOString(), answerMessageId: offset + 50 },
      }
    }
    const service = new AutomaticLearningService(database, { discover, resolve: async () => source })
    await expect(service.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' })).resolves.toEqual({ status: 'idle' })
    const anchor = await admin.query(`SELECT source_namespace, status FROM "${schema}".agent_knowledge_candidates`)
    expect(anchor.rows).toEqual([{ source_namespace: 'automatic-support-learning-cursor-v1', status: 'quarantined' }])
    await expect(service.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' })).resolves.toMatchObject({ status: 'claimed', mode: 'learn' })
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
