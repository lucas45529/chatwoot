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
    const expirySql = String(query.mock.calls[1]?.[0])
    expect(expirySql).toContain('agent_delivery_ledger')
    expect(expirySql).toContain("interval '120 days'")
    expect(expirySql).toContain('LIMIT 1000')
  })
})


it('never learns a human correction from a document-marked conversation', async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: '1', tenant_key: 'saas', conversation_id: '77', message_id: '55', sent_at: new Date(Date.now() - 3600000) }] }).mockResolvedValue({ rows: [] })
  const connect = vi.fn()
  const chatQuery = vi.fn().mockResolvedValue({ rows: [{ status: 1, human_reply_content: 'Private invoice correction', document_assistance: true }] })
  const result = await runAutoSendFeedbackSweep({ agentPool: { query, connect } as unknown as LearningPool & { query: typeof query }, chatwootPool: { query: chatQuery }, tenants: { requireByKey: () => ({ accountId: 101 }) } as unknown as TenantRegistry })
  expect(result).toMatchObject({ helpful: 0, corrected: 0, undecided: 1 })
  expect(connect).not.toHaveBeenCalled()
  expect(chatQuery.mock.calls[0]?.[0]).toContain('document_assistance_note')
})
