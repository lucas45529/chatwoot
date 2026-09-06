import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const bootstrap = fileURLToPath(new URL('../../../deployment/myinvest/bootstrap/support_experience.rb', import.meta.url))
const html = execFileSync('ruby', ['-e', 'require ARGV[0]; print Myinvest::SupportExperience::DASHBOARD_SCRIPT', bootstrap], { encoding: 'utf8' })
const script = html.replace(/^\s*<script[^>]*>/, '').replace(/<\/script>\s*$/, '')
const original = 'Öffne Kontakte und wähle Bearbeiten.'
const correction = 'Öffne Kontakte und wähle den Namen.'

function dashboard(pathname = '/app/accounts/101/inbox/17/conversations/77') {
  const parent = { postMessage: vi.fn() }
  const listeners = new Map<string, (event: unknown) => void>()
  const documentListeners = new Map<string, () => void>()
  const intervals: Array<() => unknown> = []
  const storage = new Map<string, string>()
  const editor = {
    saveDraft() {}, isPrivate: false, isEditorDisabled: false, replyType: 'REPLY', message: correction,
    currentChat: { id: 77, messages: [{ id: 61, private: true, message_type: 1 as number | string, sender: { type: 'agent_bot' }, content: `KI-Entwurf\n\nAntwortvorschlag:\n${original}\nQuellen: Hilfe`, content_attributes: { myinvest_agent_delivery_id: '55', myinvest_agent_message_kind: 'draft_note' } }] },
  }
  let click: (() => void) | undefined
  let button: { disabled: boolean; title: string; textContent: string } | undefined
  const actions = {
    classList: { add() {} },
    querySelector: (selector: string) => selector === 'button' ? { className: 'token-button' } : button,
    prepend(value: typeof button) { button = value },
  }
  const box = { __vueParentComponent: { proxy: editor }, querySelector: () => actions }
  const axios = vi.fn().mockResolvedValue({ data: { has_draft: false } })
  const window = {
    parent, location: { pathname, reload: vi.fn() }, axios,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    setInterval: (callback: () => unknown) => intervals.push(callback), setTimeout() {},
  }
  const document = {
    querySelector: (selector: string) => selector === '.reply-box' ? box : null,
    addEventListener: (name: string, listener: () => void) => documentListeners.set(name, listener),
    createElement: () => ({ dataset: {}, addEventListener: (_name: string, listener: () => void) => { click = listener } }),
  }
  runInNewContext(script, { window, document })
  const host = (origin = 'https://www.myinvest-pro.de', source: unknown = parent, data: unknown = { type: 'myinvest-support-learning-host', version: 1 }) => listeners.get('message')?.({ origin, source, data })
  return { parent, editor, host, button: () => button, click: () => click?.(), tick: () => intervals[0]?.(), sync: () => intervals[1]?.(), storage, axios, window }
}

describe('embedded draft learning bridge', () => {
  it('requires exact host origin, parent window and handshake schema before showing action', () => {
    const ui = dashboard()
    ui.host('https://evil.example'); ui.host(undefined, {}); ui.host(undefined, undefined, { type: 'myinvest-support-learning-host', version: 1, extra: true })
    expect(ui.button()).toBeUndefined()
    ui.host(); expect(ui.button()?.disabled).toBe(false)
  })

  it('hands corrected live editor text and immutable source IDs to the exact parent only', () => {
    const ui = dashboard()
    ui.host('https://app.myinvest-pro.de'); ui.click()
    const [intent, origin] = ui.parent.postMessage.mock.calls[0]!
    expect(JSON.parse(JSON.stringify(intent))).toEqual({ type: 'myinvest-support-learning', version: 1, source: { accountId: 101, conversationId: 77, questionMessageId: 55, draftMessageId: 61 }, correctedAnswer: correction })
    expect(origin).toBe('https://app.myinvest-pro.de')
    expect(ui.axios).not.toHaveBeenCalled()
    expect(ui.storage.has('draftMessages')).toBe(false)
  })

  it('rejects unchanged/empty edits, private note mode, reference-only notes and stale selection at click time', () => {
    const ui = dashboard(); ui.host()
    for (const value of ['', original]) { ui.editor.message = value; ui.tick(); ui.click(); expect(ui.button()?.disabled).toBe(true) }
    ui.editor.message = correction; ui.editor.isPrivate = true; ui.tick(); ui.click()
    ui.editor.isPrivate = false; ui.editor.currentChat.id = 78; ui.click()
    ui.editor.currentChat.id = 77; ui.editor.currentChat.messages[0]!.content = `Vorschlag zur Referenz:\n${original}`; ui.tick(); ui.click()
    expect(ui.parent.postMessage).not.toHaveBeenCalled()
  })

  it('uses latest actually written draft, excluding a newer unadopted reference', () => {
    const ui = dashboard()
    ui.editor.currentChat.messages.push({ ...ui.editor.currentChat.messages[0]!, id: 63, content: 'Vorschlag zur Referenz:\nNeuer Vorschlag', content_attributes: { myinvest_agent_delivery_id: '62', myinvest_agent_message_kind: 'draft_note' } })
    ui.host(); ui.click()
    expect(ui.parent.postMessage.mock.calls[0]?.[0].source.questionMessageId).toBe(55)
  })

  it.each([0, 'incoming'])('refuses ambiguous old-draft learning after a new customer question (%s)', (message_type) => {
    const ui = dashboard()
    const note = ui.editor.currentChat.messages[0]!
    ui.editor.currentChat.messages.push(
      { ...note, id: 63, private: false, message_type, sender: { type: 'contact' }, content: 'Wo finde ich die Rechnung?' },
      { ...note, id: 64, content: 'Vorschlag zur Referenz:\nDie Rechnung findest du im Konto.', content_attributes: { myinvest_agent_delivery_id: '63', myinvest_agent_message_kind: 'draft_note' } },
    )
    ui.editor.message = 'Die Rechnung findest du im Bereich Abrechnung.'
    ui.host(); ui.click()
    expect(ui.button()?.disabled).toBe(true)
    expect(ui.parent.postMessage).not.toHaveBeenCalled()
  })

  it.each([1, 'outgoing'])('does not attach a new correction to an older draft consumed by a public reply (%s)', (message_type) => {
    const ui = dashboard()
    const note = ui.editor.currentChat.messages[0]!
    ui.editor.currentChat.messages.push(
      { ...note, id: 62, private: false, message_type, sender: { type: 'user' }, content: 'Antwort zu Kontakten.' },
      { ...note, id: 63, private: false, message_type: 0, sender: { type: 'contact' }, content: 'Wo finde ich die Rechnung?' },
      { ...note, id: 64, content: 'Vorschlag zur Referenz:\nDie Rechnung findest du im Konto.', content_attributes: { myinvest_agent_delivery_id: '63', myinvest_agent_message_kind: 'draft_note' } },
    )
    ui.editor.message = 'Die Rechnung findest du im Bereich Abrechnung.'
    ui.host(); ui.click()
    expect(ui.button()?.disabled).toBe(true)
    expect(ui.parent.postMessage).not.toHaveBeenCalled()
  })

  it('rejects an original draft when the customer reply precedes its delayed private note', () => {
    const ui = dashboard()
    const note = ui.editor.currentChat.messages[0]!
    ui.editor.currentChat.messages.push(
      { ...note, id: 57, private: false, message_type: 1, sender: { type: 'user' }, content: 'Die Antwort wurde vor der privaten Notiz gesendet.' },
      { ...note, id: 63, private: false, message_type: 0, sender: { type: 'contact' }, content: 'Wo finde ich die Rechnung?' },
      { ...note, id: 64, content: 'Vorschlag zur Referenz:\nDie Rechnung findest du im Konto.', content_attributes: { myinvest_agent_delivery_id: '63', myinvest_agent_message_kind: 'draft_note' } },
    )
    ui.editor.message = 'Die Rechnung findest du im Bereich Abrechnung.'
    ui.host(); ui.click()
    expect(ui.button()?.disabled).toBe(true)
    expect(ui.parent.postMessage).not.toHaveBeenCalled()
  })

  it.each(['/app/accounts/101/conversations/77', '/app/accounts/101/inbox/17/conversations/77'])('synchronizes drafts on the real conversation route %s', async (pathname) => {
    const ui = dashboard(pathname)
    await ui.sync()
    expect(ui.axios).toHaveBeenCalledWith({ url: '/api/v1/accounts/101/conversations/77/draft_messages' })
  })
})
