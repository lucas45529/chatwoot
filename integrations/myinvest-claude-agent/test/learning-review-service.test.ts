import { describe, expect, it, vi } from 'vitest'
import { LearningReviewService, matchReviewedExamples } from '../src/learning/review-service.js'

function fixture(status = 'published', tenant = 'saas') {
  return { id: '9', tenant, question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle Bearbeiten.', status, reason: '', updatedAt: '2026-09-05T08:00:00Z', published_document_id: '81', reviewed_by: 'chatwoot-human-send' }
}

function database(row = fixture()) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('FOR UPDATE')) return { rows: values?.[1] === row.tenant ? [row] : [] }
    if (sql.includes('INSERT INTO agent_knowledge_candidates')) return { rows: [{ id: '10' }] }
    if (sql.includes('FROM agent_knowledge_candidates')) return { rows: [{ ...row, id: '10', status: 'pending_review' }] }
    return { rows: [] }
  })
  return { query, service: new LearningReviewService({ connect: async () => ({ query, release: vi.fn() }) }) }
}

describe('existing learning candidate review', () => {
  it('cannot edit or publish a candidate through another tenant', async () => {
    const { service, query } = database()
    await expect(service.execute({ action: 'publish', tenant: 'new_academy', id: '9' }))
      .rejects.toMatchObject({ status: 404 })
    expect(query.mock.calls.some(([sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false)
  })

  it('retires a published version and creates a pending replacement on correction', async () => {
    const { service, query } = database()
    await service.execute({ action: 'save', tenant: 'saas', id: '9', question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle den Namen.', reason: 'Der bisherige Knopf existiert nicht mehr.' })
    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain("status = 'rejected'")
    expect(sql).toContain("publication_status = 'retired'")
    expect(sql).toContain('INSERT INTO agent_knowledge_candidates')
    expect(sql).not.toContain('INSERT INTO agent_knowledge_documents')
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('rejects credentials rather than persisting them', async () => {
    const { service, query } = database()
    await expect(service.execute({ action: 'save', tenant: 'saas', question: 'Welcher Zugang?', answer: 'Nutze sk-abcdefghijklmnopqrstuv.', reason: 'Korrektur' })).rejects.toMatchObject({ status: 422 })
    expect(query).not.toHaveBeenCalled()
  })

  it('versions pending edits too, so an older review tab cannot approve new text', async () => {
    const { service, query } = database(fixture('pending_review'))
    await service.execute({ action: 'save', tenant: 'saas', id: '9', question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle den Namen.', reason: 'Besserer Ablauf' })
    expect(query.mock.calls.some(([sql]) => sql.includes("status = 'rejected'"))).toBe(true)
    expect(query.mock.calls.some(([sql]) => sql.includes('SET question_redacted'))).toBe(false)
    const stale = database(fixture('rejected'))
    await expect(stale.service.execute({ action: 'publish', tenant: 'saas', id: '9' })).rejects.toMatchObject({ status: 409 })
    expect(stale.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO agent_knowledge_documents'))).toBe(false)
  })

  it('retrieval includes explicit publication provenance, active document and tenant filters', async () => {
    const { service, query } = database()
    await service.execute({ action: 'retrieve', tenant: 'saas', question: 'Wie bearbeite ich Kontakte?' })
    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain("c.reviewed_by = 'intern-support-review'")
    expect(sql).toContain("a.actor = 'intern-support-review'")
    expect(sql).toContain("d.active = true")
    expect(sql).toContain('c.target_tenant = $1')
  })

  it('requires specific matching terms and returns at most three reviewed examples', () => {
    expect(matchReviewedExamples('Wie kann ich das machen?', [fixture()])).toEqual([])
    expect(matchReviewedExamples('Wie bearbeite ich Kontakte?', Array.from({ length: 5 }, (_, i) => ({ ...fixture(), id: String(i) })))).toHaveLength(3)
    expect(matchReviewedExamples('Wie bearbeite ich Immobilien?', [fixture()])).toEqual([])
  })
})
