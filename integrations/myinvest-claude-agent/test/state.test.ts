import { describe, expect, it, vi } from 'vitest'
import { PostgresAgentState } from '../src/state.js'

describe('PostgresAgentState', () => {
  it('binds tenant and conversation to persistent handoff checks', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }] })
    const state = new PostgresAgentState({ query })
    await expect(state.isHandedOff('legacy_academy', 42)).resolves.toBe(true)
    expect(query.mock.calls[0]![0]).toContain('tenant_key = $1')
    expect(query.mock.calls[0]![1]).toEqual(['legacy_academy', 42])
  })

  it('atomically claims new, failed-sentinel and stale deliveries', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'processing', acquired: true }] })
    const state = new PostgresAgentState({ query })
    await expect(state.beginDelivery('saas', 55, 9)).resolves.toEqual({
      status: 'processing',
      acquired: true,
    })
    expect(query.mock.calls[0]![0]).toContain('ON CONFLICT (tenant_key, message_id) DO UPDATE')
    expect(query.mock.calls[0]![0]).toContain('agent_delivery_ledger.conversation_id < 0')
    expect(query.mock.calls[0]![0]).toContain("interval '5 minutes'")
    expect(query.mock.calls[0]![1]).toEqual(['saas', 55, 9])
  })

  it('completes conversation handoff and delivery ledger in one statement', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ completed: 1 }] })
    const state = new PostgresAgentState({ query })
    await state.completeHandoff('new_academy', 55, 77)
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]![0]).toContain('INSERT INTO agent_conversation_states')
    expect(query.mock.calls[0]![0]).toContain("SET status = 'handed_off'")
    expect(query.mock.calls[0]![0]).toContain("status = 'processing'")
    expect(query.mock.calls[0]![1]).toEqual(['new_academy', 55, 77])
  })

  it('rejects a handoff when the claimed ledger row was not completed', async () => {
    const state = new PostgresAgentState({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    })
    await expect(state.completeHandoff('saas', 55, 77)).rejects.toThrow(
      /could not complete handoff/,
    )
  })

  it('re-arms only non-terminal processing or sending deliveries', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ updated: 1 }] })
    const state = new PostgresAgentState({ query })
    await state.failDelivery('saas', 55)
    expect(query.mock.calls[0]![0]).toContain('conversation_id = -ABS(conversation_id)')
    expect(query.mock.calls[0]![0]).toContain("status = 'processing'")
    expect(query.mock.calls[0]![0]).toContain("status IN ('processing', 'sending')")
    expect(query.mock.calls[0]![1]).toEqual(['saas', 55])
  })
})
