import { describe, expect, it, vi } from 'vitest'
import { PostgresKnowledgeRepository } from '../src/knowledge/repository.js'

function row(title: string, score: number) {
  return { source_id: title, title, content: `Inhalt ${title}`, metadata: {}, score }
}

describe('knowledge search', () => {
  it('requires explicit human publication and a live tenant/document binding in both query paths', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await new PostgresKnowledgeRepository({ query }).search('saas', 'Kontakt bearbeiten', 4)

    expect(query).toHaveBeenCalledTimes(2)
    for (const [sql, values] of query.mock.calls) {
      expect(values).toEqual(['saas', 'Kontakt bearbeiten', 4])
      expect(sql).toContain('d.learning_candidate_id IS NULL')
      expect(sql).toContain('c.id = d.learning_candidate_id')
      expect(sql).toContain('c.target_tenant = d.tenant_key')
      expect(sql).toContain('c.published_document_id = d.id')
      expect(sql).toContain("c.status = 'published'")
      expect(sql).toContain("c.reviewed_by = 'intern-support-review'")
      expect(sql).toContain('a.candidate_id = c.id')
      expect(sql).toContain('a.tenant_key = c.target_tenant')
      expect(sql).toContain("a.action = 'published'")
      expect(sql).toContain("a.actor = 'intern-support-review'")
      expect(sql).toContain("d.publication_status = 'published'")
      expect(sql).toContain('d.active = true')
    }
  })

  it('returns strict AND matches without touching the relaxed fallback', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row('Was-kostet-MyInvest-Pro', 0.3)] })
    const repository = new PostgresKnowledgeRepository({ query })

    const hits = await repository.search('saas', 'Was kostet MyInvest Pro?', 4)

    expect(hits.map((hit) => hit.title)).toEqual(['Was-kostet-MyInvest-Pro'])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('websearch_to_tsquery')
  })

  it('falls back to OR matching when the strict query finds nothing', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row('KfW-Foerderung', 0.6)] })
    const repository = new PostgresKnowledgeRepository({ query })

    const hits = await repository.search('saas', 'Welche KfW-Förderung gibt es?', 4)

    expect(hits.map((hit) => hit.title)).toEqual(['KfW-Foerderung'])
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[0]).toContain('plainto_tsquery')
    // Umlaut-Transliteration (ae/oe/ue/ss) gegen den normalisierten Suchvektor.
    expect(query.mock.calls[1]?.[0]).toContain("'ä', 'ae'")
    expect(query.mock.calls[1]?.[0]).toContain("'ß', 'ss'")
  })

  it('returns empty when both queries find nothing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const repository = new PostgresKnowledgeRepository({ query })

    const hits = await repository.search('saas', 'Duesenjet mieten', 4)

    expect(hits).toEqual([])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('falls back to OR matching when strict hits stay below minScore', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row('Steuerreport-Immobilien-Kapitalanlage', 0.001)] })
      .mockResolvedValueOnce({ rows: [row('06_Sonder_AfA_7b', 1.0)] })
    const repository = new PostgresKnowledgeRepository({ query })

    const hits = await repository.search('new_academy', 'Was ist die Sonder-AfA nach §7b EStG?', 4, 0.05)

    expect(hits.map((hit) => hit.title)).toEqual(['06_Sonder_AfA_7b'])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps weak strict hits when the relaxed fallback finds nothing', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row('irgendwas', 0.01)] })
      .mockResolvedValueOnce({ rows: [] })
    const repository = new PostgresKnowledgeRepository({ query })

    const hits = await repository.search('saas', 'etwas exotisches', 4, 0.05)

    expect(hits.map((hit) => hit.title)).toEqual(['irgendwas'])
    expect(query).toHaveBeenCalledTimes(2)
  })
})
