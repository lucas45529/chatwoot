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
    for (const clause of ['message.private = false', 'message.account_id = $1', 'message.inbox_id = $4', 'message.conversation_id = $2', '(message.created_at, message.id) < (current_message.created_at, current_message.id)', 'message.status IN (0, 1, 2)', 'LIMIT 100']) expect(sql).toContain(clause)
    expect(sql).toContain('processed_message_content')
    expect(sql).not.toContain('draft_note')
  })
})

it('restores more than26 calendar dates without leaking internal placeholders', () => {
  const dates = Array.from({ length: 40 }, (_, index) => `${String(index % 28 + 1).padStart(2, '0')}.09.2026`)
  const text = dates.map((date) => `Termin: ${date}.`).join(' ')
  expect(redactConversationText(text)).toBe(text)
})

describe('bounded older customer evidence', () => {
  const row = (id: number, content: string, sender_type = 'Contact') => ({ id: String(id), created_at: new Date(`2026-09-01T10:00:00Z`), message_type: sender_type === 'Contact' ? 0 : 1, sender_type, content })
  it('keeps original customer quotes400/402 before source836 alongside the latest11 turns', async () => {
    const recent = Array.from({ length: 20 }, (_, n) => row(600 + n, `Aktueller Verlauf ${n}`))
    const query = vi.fn().mockResolvedValue({ rows: [row(400, 'Erster Lead: alpha@example.test'), row(402, 'Zweiter Lead: beta@example.test; nur Anrufbeantworter erreichbar.'), ...recent] })
    const history = await loadConversationHistory({ query }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(history).toHaveLength(12)
    expect(history[0]?.role).toBe('customer')
    expect(history[0]?.text).toContain('Ältere Kundenangaben')
    expect(history[0]?.text).toContain('#400 · 2026-09-01T10:00:00.000Z')
    expect(history[0]?.text).toContain('#402 · 2026-09-01T10:00:00.000Z')
    expect(history[0]?.text).toContain('Erster Lead: [E-MAIL/ACCOUNT]')
    expect(history[0]?.text).toContain('nur Anrufbeantworter erreichbar.')
    expect(history[0]?.text).not.toContain('@example.test')
    expect(history.slice(1).map(t => t.text)).toEqual(recent.slice(-11).map(r => r.content))
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT 100')
    expect(query.mock.calls[0]?.[0]).toContain('6000')
  })
  it('keeps the public question and customer request binding contact400, without assigning contact402 the same role', async () => {
    const recent = Array.from({ length: 20 }, (_, n) => row(600 + n, `Aktueller Verlauf ${n}`))
    const rows = [row(352, 'Bitte den ersten Kontakt ersetzen, weil er nicht qualifiziert war.'),
      row(354, 'Teile uns bitte Namen und E-Mail des Kunden mit, der kein Interesse hat.', 'User'),
      row(360, 'Der Support lässt zu wünschen übrig.'), row(365, 'Da passt etwas nicht.'),
      row(400, 'Sven Beispiel alpha@example.test'),
      row(402, 'Dieser hier ist nur auf dem AB erreichbar: Thomas Beispiel beta@example.test'), ...recent]
    const history = await loadConversationHistory({ query: vi.fn().mockResolvedValue({ rows }) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    const anchor = history[0]!.text
    expect(anchor).toContain('Bitte den ersten Kontakt ersetzen, weil er nicht qualifiziert war.')
    expect(anchor).toContain('#354 · 2026-09-01T10:00:00.000Z · Mitarbeiter:')
    expect(anchor).toContain('Teile uns bitte Namen und E-Mail des Kunden mit, der kein Interesse hat.')
    expect(anchor).toContain('#400 · 2026-09-01T10:00:00.000Z · Kunde:')
    expect(anchor).toContain('Sven Beispiel [E-MAIL/ACCOUNT]')
    expect(anchor).toContain('nur auf dem AB erreichbar: Thomas Beispiel')
    expect(anchor.match(/#354 ·/g)).toHaveLength(1)
    expect(anchor.indexOf('#354')).toBeLessThan(anchor.indexOf('#400'))
    expect(anchor.indexOf('#400')).toBeLessThan(anchor.indexOf('#402'))
    expect(history.slice(1).map(t => t.text)).toEqual(recent.slice(-11).map(r => r.content))
    expect(history.every(t => t.text.length <= 1500)).toBe(true)
  })
  it('budgets linked public context and keeps contact evidence even after long introductions', async () => {
    const rows = Array.from({ length: 4 }, (_, n) => [row(300 + n * 3, 'Kundenanliegen. '.repeat(100)), row(301 + n * 3, 'Öffentliche Frage. '.repeat(100), 'User'), row(302 + n * 3, 'Lange Einleitung. '.repeat(100) + `Kontakt ${n}: test@example.test`)]).flat()
    rows.push(...Array.from({ length: 12 }, (_, n) => row(600 + n, 'Neue Korrektur hat Vorrang.')))
    const history = await loadConversationHistory({ query: vi.fn().mockResolvedValue({ rows }) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(history).toHaveLength(12)
    expect(history[0]!.text.match(/Mitarbeiter:/g)).toHaveLength(4)
    expect(history[0]!.text.match(/\[E-MAIL\/ACCOUNT\]/g)).toHaveLength(4)
    expect(history.every(t => t.text.length <= 1500)).toBe(true)
    expect(history.at(-1)?.text).toBe('Neue Korrektur hat Vorrang.')
  })
  it('marks older evidence as historical and keeps the newer correction last', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row(400, 'Meine Nummer: +49 171 12345678'), ...Array.from({ length: 12 }, (_, n) => row(600 + n, 'Eine Nachfrage')), row(835, 'Korrektur: Die alte Nummer gilt nicht mehr, bitte ausschließlich neu@example.test verwenden.')] })
    const history = await loadConversationHistory({ query }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(history[0]?.text).toContain('kein neuer Stand')
    expect(history[0]?.text).toContain('Spätere Korrekturen haben Vorrang')
    expect(history.at(-1)?.text).toContain('Die alte Nummer gilt nicht mehr')
    expect(history).toHaveLength(12)
  })
  it('reserves no evidence slot for old agent text or contact-free chatter', async () => {
    const rows = [row(400, 'Kunde hat alpha@example.test genannt.', 'AgentBot'), row(402, 'Hallo'), ...Array.from({ length: 12 }, (_, n) => row(600 + n, `Nachfrage ${n}`))]
    const history = await loadConversationHistory({ query: vi.fn().mockResolvedValue({ rows }) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(history.map(t => t.text)).toEqual(rows.slice(-12).map(r => r.content))
  })
  it('centers long excerpts on the actual supplied contact detail', async () => {
    const rows = [row(400, 'Langer Hintergrund. '.repeat(80) + 'Kontakt: exact@example.test. Bitte diesen prüfen.'), ...Array.from({ length: 12 }, (_, n) => row(600 + n, 'Neu'))]
    const history = await loadConversationHistory({ query: vi.fn().mockResolvedValue({ rows }) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(history[0]?.text).toContain('Kontakt: [E-MAIL/ACCOUNT]')
    expect(history[0]?.text).toContain('Bitte diesen prüfen.')
    expect(history[0]?.text).toContain('[gekürzt]')
  })
  it('bounds historical quotes and never invents provenance for missing source metadata', async () => {
    const rows = [...Array.from({ length: 10 }, (_, n) => row(400 + n, `Kontakt ${n}: test@example.test ${'Text '.repeat(200)}`)), ...Array.from({ length: 12 }, (_, n) => row(600 + n, 'Neu'))]
    const history = await loadConversationHistory({ query: vi.fn().mockResolvedValue({ rows }) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(history[0]?.text.match(/#\d+ ·/g)).toHaveLength(4)
    expect(history.every(t => t.text.length <= 1500)).toBe(true)
    expect(history[0]?.text).toContain('[gekürzt]')
    const noMetadata = rows.map(r => ({ ...r, created_at: undefined, id: undefined }))
    const plain = await loadConversationHistory({ query: vi.fn().mockResolvedValue({ rows: noMetadata }) }, { accountId: 1, inboxId: 2, conversationId: '16', currentMessageId: 836 })
    expect(plain[0]?.text).not.toContain('Ältere Kundenangaben')
  })
})
