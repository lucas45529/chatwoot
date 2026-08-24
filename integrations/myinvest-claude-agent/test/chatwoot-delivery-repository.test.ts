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
    expect(sql).toContain('json_typeof(message.content_attributes)')
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

describe('PostgresChatwootDeliveryStore conversation context', () => {
  it('loads recent roles and safe identity signals for a handed-off thread', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            conversation_id: '900',
            has_email: false,
            has_phone: true,
            has_identifier: false,
            cached_label_list: 'ki-uebergabe',
            last_agent_handoff_id: '1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            message_id: '1',
            message_type: 1,
            sender_type: 'AgentBot',
            content: 'Übergabe',
            created_at: new Date('2026-08-24T11:40:00Z'),
            agent_kind: 'handoff_ack',
            external_echo: false,
            from_automation: false,
            from_campaign: false,
          },
          {
            message_id: '2',
            message_type: 1,
            sender_type: 'User',
            content: 'Hallo, wie können wir helfen?',
            created_at: new Date('2026-08-24T11:55:00Z'),
            agent_kind: null,
            external_echo: false,
            from_automation: false,
            from_campaign: false,
          },
          {
            message_id: '3',
            message_type: 0,
            sender_type: 'Contact',
            content: 'Mir wurden zwei Leads versprochen.',
            created_at: new Date('2026-08-24T11:56:00Z'),
            agent_kind: null,
            external_echo: false,
            from_automation: false,
            from_campaign: false,
          },
        ],
      })
    const store = new PostgresChatwootDeliveryStore({ query })
    const context = await store.loadContext({
      accountId: 101,
      conversationDisplayId: 71,
      identity: { hasEmail: false, hasPhone: true, hasIdentifier: false },
      currentMessageId: 4,
    })
    expect(context).toEqual(
      expect.objectContaining({
        needsIdentityClarification: true,
        humanRepliedAfterBot: true,
        labels: ['ki-uebergabe'],
        turns: [
          expect.objectContaining({ role: 'assistant' }),
          expect.objectContaining({ role: 'human' }),
          expect.objectContaining({ role: 'customer' }),
        ],
      }),
    )
    expect(query.mock.calls[1]![0]).toContain('message.id <> $3')
    expect(query.mock.calls[1]![0]).toContain('json_typeof(message.content_attributes)')
    expect(query.mock.calls[1]![0]).toContain('message.private = false')
    expect(query.mock.calls[1]![0]).toContain("content_attributes ->> 'external_echo'")
    expect(query.mock.calls[1]![1]).toEqual([101, '900', 4])
  })
})
