import { describe, expect, it, vi } from 'vitest'
import { classifyHistoryCandidates } from '../src/learning/classify-history.js'

describe('history candidate classification', () => {
  it('tenant-classifies only redacted quarantined candidates from the mapped export', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '7',
            question_redacted: 'Wie aktiviere ich die Maklerfreigabe?',
            answer_redacted: 'Die Freigabe aktivieren Sie in den Einstellungen.',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ classified: 1 }] })
    const pool = { query, connect: vi.fn() }
    await expect(
      classifyHistoryCandidates(pool, {
        'hubspot-whatsapp-myinvest24-20260816': 'legacy_academy',
      }),
    ).resolves.toEqual({ classified: 1, rejected: 0 })

    expect(query.mock.calls[0]![0]).toContain("status = 'quarantined'")
    expect(query.mock.calls[0]![0]).not.toContain('target_tenant IS NULL')
    expect(query.mock.calls[1]![0]).toContain('target_tenant IS NULL')
    expect(query.mock.calls[1]![0]).toContain('history-tenant-classifier')
    expect(query.mock.calls[1]![1]).toEqual([
      'hubspot-whatsapp-myinvest24-20260816',
      'legacy_academy',
    ])
  })
})
