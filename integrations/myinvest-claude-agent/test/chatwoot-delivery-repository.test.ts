import { describe, expect, it, vi } from 'vitest'
import { PostgresChatwootDeliveryStore } from '../src/chatwoot-delivery-repository.js'

describe('PostgresChatwootDeliveryStore', () => {
  it('binds account, conversation, delivery and message kind in the read-only lookup', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }] })
    const store = new PostgresChatwootDeliveryStore({ query })
    await expect(
      store.exists({
        accountId: 101,
        conversationDisplayId: 77,
        deliveryId: 55,
        kind: 'handoff_ack',
      }),
    ).resolves.toBe(true)

    const sql = query.mock.calls[0]![0]
    expect(sql).toContain('conversation.account_id = $1')
    expect(sql).toContain('message.account_id = $1')
    expect(sql).toContain('conversation.display_id = $2')
    expect(sql).toContain("myinvest_agent_delivery_id")
    expect(sql).toContain("myinvest_agent_message_kind")
    expect(query.mock.calls[0]![1]).toEqual([101, 77, '55', 'handoff_ack'])
  })

  it('returns false when no scoped message marker exists', async () => {
    const store = new PostgresChatwootDeliveryStore({
      query: vi.fn().mockResolvedValue({ rows: [{ exists: false }] }),
    })
    await expect(
      store.exists({ accountId: 202, conversationDisplayId: 8, deliveryId: 9, kind: 'answer' }),
    ).resolves.toBe(false)
  })
})

describe('PostgresChatwootDeliveryStore health', () => {
  it('checks real tables instead of only the database connection', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const store = new PostgresChatwootDeliveryStore({ query })
    await store.healthCheck()
    expect(query.mock.calls[0]![0]).toContain('FROM messages CROSS JOIN conversations')
  })
})
