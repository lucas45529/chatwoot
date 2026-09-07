import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const bootstrap = fileURLToPath(new URL('../../../deployment/myinvest/bootstrap/support_experience.rb', import.meta.url))
const script = execFileSync('ruby', ['-e', 'require ARGV[0]; print Myinvest::SupportExperience::DASHBOARD_SCRIPT', bootstrap], { encoding: 'utf8' }).replace(/^\s*<script[^>]*>/, '').replace(/<\/script>\s*$/, '')
const requestId = 'baf11eb5-23d8-40c8-9452-41cfe1234567'

function dashboard() {
  const parent = { postMessage: vi.fn() }
  const listeners = new Map<string, (event: unknown) => void>()
  const documentListeners = new Map<string, (event: unknown) => void>()
  const intervals: Array<() => unknown> = []
  const timeouts: Array<() => unknown> = []
  const storage = new Map<string, string>()
  const editor = { saveDraft() {}, isPrivate: false, isEditorDisabled: false, replyType: 'REPLY', message: '', currentChat: { id: 77, messages: [{ id: 55, private: false, message_type: 0 }] } }
  const elements: Array<{ dataset: Record<string, string>; textContent?: string }> = []
  const native = { disabled: false, title: '', setAttribute: vi.fn(), querySelector: (selector: string) => selector === '.i-ph-sparkle-fill' ? {} : null }
  const actions = { classList: { add() {} }, querySelector: (selector: string) => selector === 'button' ? { className: 'token-button' } : elements.find(el => selector === '[data-myinvest-learning]' ? el.dataset.myinvestLearning : el.dataset.myinvestDraftStatus), prepend: (el: typeof elements[number]) => elements.push(el) }
  const box = {
    myinvestSupportReplyBox: {
      read: () => ({
        isPrivate: editor.isPrivate,
        isEditorDisabled: editor.isEditorDisabled,
        replyType: editor.replyType,
        message: editor.message,
        currentChat: editor.currentChat,
      }),
      normalizeDraft: (message: string) => message,
    },
    querySelector: (selector: string) => selector === '.right-wrap' ? actions : selector === '.i-ph-sparkle-fill' ? { closest: () => native } : null,
  }
  const axios = vi.fn().mockResolvedValue({ data: { has_draft: false } })
  const dispatch = vi.fn().mockImplementation(async (_action: string, { message }: { message: string }) => { editor.message = message })
  const window = {
    parent, crypto: { randomUUID: () => requestId }, location: { pathname: '/app/accounts/101/inbox/17/conversations/77', reload: vi.fn() }, axios,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    setInterval: (callback: () => unknown) => intervals.push(callback), setTimeout: (callback: () => unknown) => timeouts.push(callback), clearTimeout() {},
  }
  const document = {
    querySelector: (selector: string) => selector === '.reply-box' ? box : selector === '#app' ? { __vue_app__: { config: { globalProperties: { $store: { dispatch } } } } } : null,
    addEventListener: (name: string, listener: (event: unknown) => void) => documentListeners.set(name, listener),
    createElement: () => ({ dataset: {}, addEventListener() {}, setAttribute() {} }),
  }
  runInNewContext(script, { window, document })
  const message = (data: unknown, origin = 'https://www.myinvest-pro.de', source: unknown = parent) => listeners.get('message')?.({ data, origin, source })
  const click = () => { const event = { target: { closest: () => native }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }; documentListeners.get('click')?.(event); return event }
  return { parent, editor, box, window, axios, storage, native, message, click, host: () => message({ type: 'myinvest-support-learning-host', version: 1 }), sync: () => intervals[1]?.(), tick: () => intervals[0]?.(), timeout: () => timeouts.at(-1)?.(), status: () => elements.find(el => el.dataset.myinvestDraftStatus)?.textContent }
}

describe('MyInvest draft composer bridge', () => {
  it('disables draft creation outside the editable reply mode, including late request results', () => {
    const ui = dashboard(); ui.host(); ui.click()
    ui.editor.isPrivate = true; ui.editor.replyType = 'NOTE'; ui.tick()
    ui.message({ type: 'myinvest-support-draft-result', version: 1, requestId, status: 'unavailable' })
    expect(ui.native.disabled).toBe(true)
    ui.editor.isPrivate = false; ui.editor.replyType = 'REPLY'; ui.tick()
    expect(ui.native.disabled).toBe(false)
    ui.editor.isEditorDisabled = true; ui.tick()
    expect(ui.native.disabled).toBe(true)
  })

  it('replaces the native AI menu only after the trusted portal handshake', () => {
    const ui = dashboard(); expect('__vueParentComponent' in ui.box).toBe(false); ui.click(); expect(ui.parent.postMessage).not.toHaveBeenCalled()
    ui.host(); const event = ui.click()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(ui.parent.postMessage).toHaveBeenCalledWith({ type: 'myinvest-support-draft', version: 1, requestId, accountId: 101, conversationId: 77 }, 'https://www.myinvest-pro.de')
    expect(ui.native.disabled).toBe(true)
    expect(ui.status()).toContain('vorbereitet')
  })

  it('automatically prepares an unanswered conversation once, preserving manual edits and private notes', async () => {
    const ui = dashboard(); ui.host(); await ui.sync(); await ui.sync()
    expect(ui.parent.postMessage).toHaveBeenCalledTimes(1)
    for (const mode of ['human', 'private', 'answered']) {
      const other = dashboard(); other.host()
      if (mode === 'human') other.editor.message = 'Meine eigene Antwort'
      if (mode === 'private') other.editor.isPrivate = true
      if (mode === 'answered') other.editor.currentChat.messages[0]!.message_type = 1
      await other.sync()
      expect(other.parent.postMessage).not.toHaveBeenCalled()
    }
  })

  it('ignores forged and stale results, then loads the ready draft without a page reload', async () => {
    const ui = dashboard(); ui.host(); ui.click()
    const result = { type: 'myinvest-support-draft-result', version: 1, requestId, status: 'ready' }
    ui.message(result, 'https://evil.example'); ui.message(result, undefined, {}); ui.message({ ...result, requestId: 'stale' })
    await ui.sync()
    expect(ui.native.disabled).toBe(true); expect(ui.axios).not.toHaveBeenCalled()
    ui.axios.mockResolvedValue({ data: { has_draft: true, message: 'Ein bearbeitbarer KI-Entwurf.' } })
    ui.message(result)
    await vi.waitFor(() => expect(ui.editor.message).toBe('Ein bearbeitbarer KI-Entwurf.'))
    expect(ui.native.disabled).toBe(false); expect(ui.window.location.reload).not.toHaveBeenCalled()
  })

  it('keeps in-progress typing and offers retry after failure or timeout', async () => {
    const ui = dashboard(); ui.host(); ui.click(); ui.editor.message = 'Währenddessen selbst geschrieben'
    ui.axios.mockResolvedValue({ data: { has_draft: true, message: 'KI-Text' } })
    ui.message({ type: 'myinvest-support-draft-result', version: 1, requestId, status: 'ready' })
    await ui.sync()
    expect(ui.editor.message).toBe('Währenddessen selbst geschrieben')
    const failed = dashboard(); failed.host(); failed.click()
    failed.message({ type: 'myinvest-support-draft-result', version: 1, requestId, status: 'unavailable' })
    expect(failed.status()).toContain('erneut'); expect(failed.native.disabled).toBe(false)
    failed.click(); failed.timeout()
    expect(failed.native.disabled).toBe(false); expect(failed.status()).toContain('erneut')
  })

  it('does not apply a completed request to a different conversation', () => {
    const ui = dashboard(); ui.host(); ui.click()
    ui.window.location.pathname = '/app/accounts/101/conversations/78'; ui.editor.currentChat.id = 78
    ui.message({ type: 'myinvest-support-draft-result', version: 1, requestId, status: 'ready' })
    expect(ui.axios).not.toHaveBeenCalled()
  })

  it('withdraws a stale synchronized AI draft while preserving a human correction', async () => {
    for (const edited of [false, true]) {
      const ui = dashboard()
      ui.storage.set('draftMessages', JSON.stringify({ 'draft-77-REPLY': 'Alter KI-Entwurf' }))
      ui.storage.set('myinvest-synced-draft-101-77', 'Alter KI-Entwurf')
      ui.editor.message = edited ? 'Meine Korrektur' : 'Alter KI-Entwurf'
      ui.axios.mockResolvedValue({ data: { has_draft: true, message: '' } })
      await ui.sync()
      expect(ui.editor.message).toBe(edited ? 'Meine Korrektur' : '')
      expect(ui.window.location.reload).not.toHaveBeenCalled()
    }
  })
})
