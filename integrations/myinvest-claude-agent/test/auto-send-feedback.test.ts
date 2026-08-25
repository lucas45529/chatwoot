import { describe, expect, it, vi } from 'vitest'

import type { TenantRegistry } from '../src/config.js'
import { runAutoSendFeedbackSweep } from '../src/learning/auto-send-feedback.js'
import type { LearningPool } from '../src/learning/repository.js'

describe('runAutoSendFeedbackSweep', () => {
  it('wertet nur nachweislich gesendete Audit-Zeilen aus', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const agentPool = {
      connect: vi.fn(),
      query,
    } as unknown as LearningPool & {
      query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
    }

    await runAutoSendFeedbackSweep({
      agentPool,
      chatwootPool: { query: vi.fn() } as never,
      tenants: { requireByKey: vi.fn() } as unknown as TenantRegistry,
    })

    const sql = String(query.mock.calls[0]?.[0])
    // Ein Audit-Versuch wird vor der Chatwoot-Nachricht geschrieben. Ohne
    // sent_at-Filter koennte ein final gescheiterter Send nach manueller
    // Aufloesung als "helpful" gelernt werden.
    expect(sql).toContain('sent_at IS NOT NULL')
    expect(sql).toContain('sent_at AS sent_at')
  })
})
