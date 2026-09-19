import { describe, expect, it, vi } from 'vitest'
import { loadConversationHistory, redactConversationText } from '../src/conversation-history.js'

describe('delivered conversation history', () => {
  it('preserves booking dates and Zoom context while removing phone and private URL values', () => {
    const result = redactConversationText('Termin am 19.09.2026 um 14:30 Uhr bestätigt. Zoom: https://zoom.us/j/123456789?pwd=secret Telefon +49 171 12345678')
    expect(result).toContain('19.09.2026 um 14:30 Uhr bestätigt')
    expect(result).toContain('[ZOOM-LINK]')
    expect(result).toContain('[TELEFON/NUMMER]')
    expect(result).not.toMatch(/12345678|pwd=secret/)
  })

  it('retains public automation, templates and senderless delivered messages with provenance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { message_type: 1, sender_type: null, content: 'Termin am 19.09.2026 bestätigt.', from_automation: true },
      { message_type: 3, sender_type: null, content: 'Zoom: https://zoom.us/j/123456789', from_campaign: true },
      { message_type: 1, sender_type: null, content: 'Vielen Dank für deine Telefonnummer.' },
      { message_type: 0, sender_type: 'Contact', content: 'Alles klar.' },
    ] })
    const history = await loadConversationHistory({ query }, { accountId: 1, inboxId: 2, conversationId: '3', currentMessageId: 4 })
    expect(history).toEqual([
      { role: 'assistant', text: '[Automatische Nachricht] Termin am 19.09.2026 bestätigt.' },
      { role: 'assistant', text: '[Kampagnennachricht] Zoom: [ZOOM-LINK]' },
      { role: 'assistant', text: '[Gesendete Nachricht] Vielen Dank für deine Telefonnummer.' },
      { role: 'customer', text: 'Alles klar.' },
    ])
    const sql = query.mock.calls[0]![0]
    for (const clause of ['message.private = false', 'message.account_id = $1', 'message.inbox_id = $4', 'message.conversation_id = $2', '(message.created_at, message.id) < (current_message.created_at, current_message.id)', 'message.status IN (0, 1, 2)', 'LIMIT 12']) expect(sql).toContain(clause)
    expect(sql).toContain('processed_message_content')
    expect(sql).not.toContain('draft_note')
  })
})

it('restores more than26 calendar dates without leaking internal placeholders', () => {
  const dates = Array.from({ length: 40 }, (_, index) => `${String(index % 28 + 1).padStart(2, '0')}.09.2026`)
  const text = dates.map((date) => `Termin: ${date}.`).join(' ')
  expect(redactConversationText(text)).toBe(text)
})
