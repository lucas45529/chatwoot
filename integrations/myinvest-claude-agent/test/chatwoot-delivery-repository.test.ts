import { createHmac } from 'node:crypto'
import {
  contactFingerprint,
  questionFingerprint,
  supportBrainRequestId,
} from '../src/auto-send.js'
import { describe, expect, it, vi } from 'vitest'
import { PostgresChatwootDeliveryStore } from '../src/chatwoot-delivery-repository.js'
import { PSEUDONYMIZATION_KEY } from './fixtures.js'

describe('PostgresChatwootDeliveryStore', () => {
  it('binds account, conversation, delivery and message kind in the read-only lookup', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }] })
    const store = new PostgresChatwootDeliveryStore({ query }, PSEUDONYMIZATION_KEY)
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
    const store = new PostgresChatwootDeliveryStore(
      {
        query: vi.fn().mockResolvedValue({ rows: [{ exists: false }] }),
      },
      PSEUDONYMIZATION_KEY,
    )
    await expect(
      store.exists({ accountId: 202, conversationDisplayId: 8, deliveryId: 9, kind: 'answer' }),
    ).resolves.toBe(false)
  })
})

describe('PostgresChatwootDeliveryStore health', () => {
  it('checks real tables instead of only the database connection', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const store = new PostgresChatwootDeliveryStore({ query }, PSEUDONYMIZATION_KEY)
    await store.healthCheck()
    expect(query.mock.calls[0]![0]).toContain('FROM messages CROSS JOIN conversations')
    expect(query.mock.calls[0]![0]).toContain('CROSS JOIN contacts')
  })

  it('returns no context for a signed webhook whose conversation no longer exists', async () => {
    const store = new PostgresChatwootDeliveryStore(
      {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      },
      PSEUDONYMIZATION_KEY,
    )
    await expect(
      store.loadContext({
        accountId: 101,
        conversationDisplayId: 999_999,
        currentMessageId: 55,
      }),
    ).resolves.toBeUndefined()
  })
})

describe('PostgresChatwootDeliveryStore conversation context', () => {
  it('loads recent roles and a pseudonymous contact signal for a handed-off thread', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            conversation_id: '900',
            contact_id: '4242',
            contact_email: 'kunde@example.de',
            cached_label_list: 'ki-uebergabe',
            last_human_message_id: '3',
            last_agent_handoff_id: '1',
            last_agent_draft_note:
              'KI-Antwortentwurf wartet auf menschliche Freigabe (brain_declined).\n\nAntwortvorschlag:\nAlter KI-Entwurf\nGrundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.',
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
    const store = new PostgresChatwootDeliveryStore({ query }, PSEUDONYMIZATION_KEY)
    const context = await store.loadContext({
      accountId: 101,
      conversationDisplayId: 71,
      currentMessageId: 4,
    })
    expect(context).toEqual({
      humanRepliedAfterBot: true,
      labels: ['ki-uebergabe'],
      humanEverReplied: true,
      previousAgentDraft: 'Alter KI-Entwurf',
      turns: [
        { role: 'assistant', text: 'Übergabe' },
        { role: 'human', text: 'Hallo, wie können wir helfen?' },
        { role: 'customer', text: 'Mir wurden zwei Leads versprochen.' },
      ],
      // Ratengrenzen brauchen nur Gleichheit: der Kontakt verlaesst Chatwoot
      // als accountgebundenes Pseudonym, nie als ID oder Kontaktangabe.
      contactHash: createHmac('sha256', PSEUDONYMIZATION_KEY)
        .update('myinvest-claude-agent/contact/v1\u0000101\u00004242')
        .digest('hex'),
      contactEmail: 'kunde@example.de',
    })
    expect(context!.contactHash).not.toContain('4242')
    expect(query.mock.calls[0]![1]).toEqual([101, 71])
    expect(query.mock.calls[0]![0]).toContain('JOIN contacts')
    expect(query.mock.calls[0]![0]).toContain('AS last_human_message_id')
    expect(query.mock.calls[0]![0]).toContain('AS last_agent_draft_note')
    expect(query.mock.calls[0]![0]).toContain(
      "IN ('handoff_note', 'draft_note', 'clarify_draft_note')",
    )
    expect(query.mock.calls[0]![0]).toContain(
      "draft_note.content LIKE '%Antwortvorschlag:%'",
    )
    expect(query.mock.calls[1]![0]).toContain('message.id <> $3')
    expect(query.mock.calls[1]![0]).toContain('json_typeof(message.content_attributes)')
    expect(query.mock.calls[1]![0]).toContain('message.private = false')

    expect(query.mock.calls[1]![0]).toContain("content_attributes ->> 'external_echo'")
    expect(query.mock.calls[1]![1]).toEqual([101, '900', 4])
  })

  it('keys and domain-separates production pseudonyms', () => {
    const contact = contactFingerprint(PSEUDONYMIZATION_KEY, 101, '4242')
    const otherKeyContact = contactFingerprint(
      'another-independent-pseudonymization-key-2026',
      101,
      '4242',
    )
    const question = questionFingerprint(PSEUDONYMIZATION_KEY, 'saas', '4242')
    expect(contact).toBe(
      createHmac('sha256', PSEUDONYMIZATION_KEY)
        .update('myinvest-claude-agent/contact/v1\u0000101\u00004242')
        .digest('hex'),
    )

    expect(contact).not.toBe(otherKeyContact)
    expect(contact).not.toBe(question)
    const requestId = supportBrainRequestId(PSEUDONYMIZATION_KEY, 101, 55)
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(requestId).toBe(
      supportBrainRequestId(PSEUDONYMIZATION_KEY, 101, 55),
    )
    expect(requestId).not.toBe(
      supportBrainRequestId(PSEUDONYMIZATION_KEY, 101, 56),
    )
  })

  it('erkennt eine historische Menschenantwort auch ausserhalb des Verlaufsfensters', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            conversation_id: '501',
            contact_id: '9',
            contact_email: null,
            cached_label_list: 'ki-uebergabe',
            last_human_message_id: '50',
            last_agent_handoff_id: '40',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
    const store = new PostgresChatwootDeliveryStore({ query }, PSEUDONYMIZATION_KEY)

    await expect(
      store.loadContext({
        accountId: 101,
        conversationDisplayId: 71,
        currentMessageId: 55,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        turns: [],
        humanEverReplied: true,
        humanRepliedAfterBot: true,
      }),
    )
  })
})
