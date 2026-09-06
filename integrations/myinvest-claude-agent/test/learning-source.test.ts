import { describe, expect, it, vi } from 'vitest'
import { buildTenantRegistry } from '../src/config.js'
import { PostgresLearningSourceResolver, learningSourceSchema } from '../src/learning/source.js'
import { LearningReviewService, learningCommandSchema } from '../src/learning/review-service.js'
import { tenants } from './fixtures.js'

const source = { accountId: 101, conversationId: 77, questionMessageId: 55, draftMessageId: 61 }
const draft = 'Öffne Kontakte und wähle Bearbeiten.'
const pinnedTenants = tenants.map((tenant, index) => ({ ...tenant, agentBotId: 801 + index }))

describe('authenticated conversation learning source', () => {
  it('resolves immutable question and original draft through tenant-bound read-only joins', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ question: 'Wie bearbeite ich Kontakte?', draft_note: `KI-Entwurf\n\nAntwortvorschlag:\n${draft}\nQuellen: Hilfe` }] })
    const resolver = new PostgresLearningSourceResolver({ query }, buildTenantRegistry(pinnedTenants))
    await expect(resolver.resolve(source)).resolves.toEqual({ tenant: 'saas', source, question: 'Wie bearbeite ich Kontakte?', previousDraft: draft })
    expect(query.mock.calls[0]?.[1]).toEqual([101, 77, 55, 61, 801, 17])
    expect(query.mock.calls[0]?.[0]).toContain('c.inbox_id = $6')
    const sql = query.mock.calls[0]?.[0] as string
    for (const constraint of ['c.display_id = $2', 'q.account_id = c.account_id', 'n.account_id = c.account_id', 'q.private = false', 'n.private = true', "n.sender_type = 'AgentBot'", 'n.sender_id = $5', 'myinvest_agent_delivery_id', 'sent.id > q.id', 'sent.private = false', 'sent.message_type = 1']) expect(sql).toContain(constraint)
    expect(sql).not.toMatch(/\b(accounts|inboxes|agent_bots|access_tokens|agent_bot_inboxes)\b/)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
    expect(sql).toContain('newer.id > q.id')
    expect(sql).toContain('newer.message_type = 0 AND newer.private = false')
  })

  it('rejects another account before database access and rejects mismatched source joins', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const resolver = new PostgresLearningSourceResolver({ query }, buildTenantRegistry(pinnedTenants))
    await expect(resolver.resolve({ ...source, accountId: 999 })).rejects.toMatchObject({ status: 404 })
    expect(query).not.toHaveBeenCalled()
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 404 })
  })

  it.each(['Vorschlag zur Referenz:\nNicht geschrieben.', 'Antwortvorschlag: forged', '\n\nAntwortvorschlag:\n\nGrundlage: leer'])('rejects absent or reference-only original draft: %s', async (draft_note) => {
    const resolver = new PostgresLearningSourceResolver({ query: vi.fn().mockResolvedValue({ rows: [{ question: 'Frage nach Kontakten', draft_note }] }) }, buildTenantRegistry(pinnedTenants))
    await expect(resolver.resolve(source)).rejects.toMatchObject({ status: 422 })
  })

  it('does not connect to candidate storage for source reads or cross-tenant saves', async () => {
    const connect = vi.fn()
    const resolve = vi.fn().mockResolvedValue({ tenant: 'saas', source, question: 'Wie bearbeite ich Kontakte?', previousDraft: draft })
    const service = new LearningReviewService({ connect }, { resolve })
    await expect(service.execute({ action: 'source', source })).resolves.toHaveProperty('previousDraft', draft)
    await expect(service.execute({ action: 'save', tenant: 'new_academy', source, question: 'Wie bearbeite ich Kontakte?', answer: draft, reason: 'Korrigiert' })).rejects.toMatchObject({ status: 422 })
    expect(connect).not.toHaveBeenCalled()
  })

  it('validates bounded numeric IDs and rejects extra text in the provenance envelope', () => {
    expect(learningCommandSchema.safeParse({ action: 'source', source }).success).toBe(true)
    for (const invalid of [{ ...source, draftMessageId: 0 }, { ...source, accountId: Number.MAX_SAFE_INTEGER + 1 }, { ...source, question: 'untrusted' }]) expect(learningSourceSchema.safeParse(invalid).success).toBe(false)
  })

  it('keeps legacy registries usable and fails only source lookup when identity metadata is absent', async () => {
    const registry = buildTenantRegistry(tenants)
    expect(registry.requireByKey('saas').accountId).toBe(101)
    const query = vi.fn()
    await expect(new PostgresLearningSourceResolver({ query }, registry).resolve(source)).rejects.toMatchObject({ status: 503, message: 'learning_source_identity_unavailable' })
    expect(query).not.toHaveBeenCalled()
  })

  it('preserves verified source IDs through list and edit using audit details only', async () => {
    const row = { id: '9', tenant: 'saas', question: 'Wie bearbeite ich Kontakte?', answer: draft, status: 'pending_review', source, reason: 'Korrigiert', updatedAt: '2026-09-06T12:00:00Z', published_document_id: null, reviewed_by: 'intern-support-review' }
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO agent_knowledge_candidates')) return { rows: [{ id: '10' }] }
      if (sql.includes('FROM agent_knowledge_candidates')) return { rows: [row] }
      return { rows: [] }
    })
    const resolve = vi.fn().mockRejectedValue(new Error('Consumed source must not be re-resolved for an existing audited example'))
    const service = new LearningReviewService({ connect: async () => ({ query, release() {} }) }, { resolve })
    await expect(service.execute({ action: 'list', tenant: 'saas' })).resolves.toMatchObject({ candidates: [{ source }] })
    await service.execute({ action: 'save', tenant: 'saas', id: '9', question: row.question, answer: 'Öffne Kontakte und wähle den Namen.', reason: 'Neuer Ablauf' })
    expect(resolve).not.toHaveBeenCalled()
    const calls = query.mock.calls
    const event = calls.find(([sql, values]) => sql.includes('INSERT INTO agent_learning_audit_events') && values?.[2] === 'feedback_recorded')
    expect(event?.[1]?.[4]).toEqual({ reason: 'Neuer Ablauf', source, previous_candidate_id: '9' })
    const insert = calls.find(([sql]) => sql.includes('INSERT INTO agent_knowledge_candidates'))
    expect(insert?.[0]).not.toContain('source_message')
    expect(event?.[1]?.[4]).not.toHaveProperty('previousDraft')
    await service.execute({ action: 'save', tenant: 'saas', id: '9', source: { ...source }, question: row.question, answer: 'Öffne Kontakte und wähle den Namen.', reason: 'Neuer Ablauf' })
    expect(resolve).not.toHaveBeenCalled()
    resolve.mockRejectedValueOnce({ status: 404, message: 'learning_source_not_found' })
    await expect(service.execute({ action: 'save', tenant: 'saas', id: '9', source: { ...source, draftMessageId: 64 }, question: row.question, answer: draft, reason: 'Neue Quelle' })).rejects.toMatchObject({ status: 404 })
    expect(resolve).toHaveBeenCalledWith({ ...source, draftMessageId: 64 })
  })
})
