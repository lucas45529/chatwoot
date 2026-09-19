import { describe, expect, it } from 'vitest'
import { MessageProcessor } from '../src/processor.js'
import type { SupportBrainAnswer, SupportBrainPort, SupportBrainRequest } from '../src/support-brain.js'
import type { ChatwootPort, DeliveryMessageKind } from '../src/chatwoot-client.js'
import type { AgentState, DeliveryStatus } from '../src/state.js'
import type { AutoSendRecord, AutoSendLog } from '../src/auto-send.js'
import type { ChatwootWebhookPayload, ConversationTurn } from '../src/domain.js'
import { incomingPayload, PSEUDONYMIZATION_KEY, tenants } from './fixtures.js'

/** No provider/network I/O: real processor, stateful fake WhatsApp transport.
 * Brain answers are scripted port responses, not a model-quality evaluation. */
function conversation(options: { alreadyHandedOff?: boolean; cap?: number } = {}) {
  const tenant = tenants[1]!
  const transcript: Array<ConversationTurn & { id: number }> = []
  const effects: Array<{ id: number; kind: DeliveryMessageKind; text: string }> = []
  const requests: SupportBrainRequest[] = []
  const deliveries = new Map<number, DeliveryStatus>()
  const reservations = new Map<number, AutoSendRecord>()
  const labels = new Set<string>()
  let current: ChatwootWebhookPayload | undefined
  let nextId = 100
  let handedOff = options.alreadyHandedOff ?? false
  let blocked = false
  let humanEverReplied = false
  let composer: string | undefined
  let previousAgentDraft: string | undefined
  let nextBrain: SupportBrainPort['answer'] = async () => { throw new Error('Unscripted Brain call') }
  const state: AgentState = {
    async isHandedOff() { return handedOff },
    async activateConversation() { handedOff = false },
    async beginDelivery(_tenant, id) {
      const existing = deliveries.get(id)
      if (existing) return { acquired: false, status: existing }
      deliveries.set(id, 'processing')
      return { acquired: true, status: 'processing' }
    },
    async markSending(_tenant, id) {
      if (deliveries.get(id) !== 'processing') throw new Error('Invalid sending transition')
      deliveries.set(id, 'sending')
    },
    async completeReply(_tenant, id) {
      if (deliveries.get(id) !== 'sending') throw new Error('Invalid reply transition')
      deliveries.set(id, 'replied')
    },
    async completeHandoff(_tenant, id) { deliveries.set(id, 'handed_off'); handedOff = true },
    async completeWithoutReply(_tenant, id) { deliveries.set(id, 'handed_off') },
    async failDelivery(_tenant, id) { deliveries.delete(id) },
  }
  const autoSend: AutoSendLog = {
    async blockConversation() { blocked = true },
    async markSent() {},
    async reserve(entry, limits) {
      const count = [...reservations.keys()].filter(id => id !== entry.messageId).length
      const usage = { blocked, conversationCount: count, contactCountLastHour: count }
      if (blocked) return { reserved: false, usage, verdict: 'human_in_conversation' }
      if (count >= limits.maxPerConversation) return { reserved: false, usage, verdict: 'conversation_limit' }
      if (count >= limits.maxPerContactPerHour) return { reserved: false, usage, verdict: 'contact_rate_limit' }
      const original = reservations.get(entry.messageId) ?? entry
      reservations.set(entry.messageId, original)
      return { reserved: true, usage, entry: original }
    },
  }
  const appendEffect = (id: number, kind: DeliveryMessageKind, text: string) => {
    if (effects.some(effect => effect.id === id && effect.kind === kind)) return false
    effects.push({ id, kind, text }); return true
  }
  const chatwoot: ChatwootPort = {
    async sendMessage(_tenant, _conversation, text, id, kind) {
      if (appendEffect(id, kind, text)) transcript.push({ id: id + 0.5, role: 'assistant', text })
    },
    async sendPrivateNote(_tenant, _conversation, text, id, kind) { appendEffect(id, kind, text) },
    async saveDraft(_tenant, _conversation, text, expected) {
      if (composer && composer !== expected) return { written: false, message: composer }
      composer = text; previousAgentDraft = text
      return { written: true, message: text }
    },
    async setPriority() {},
    async addLabels(_tenant, _conversation, added) { added.forEach(label => labels.add(label)) },
    async assign() {},
    async handoff() {},
  }
  const processor = new MessageProcessor({
    brain: { async answer(request, signal) { requests.push(request); return nextBrain(request, signal) } },
    chatwoot, state, autoSend,
    context: {
      async loadContext(input) {
        return { turns: transcript.filter(turn => turn.id < input.currentMessageId).slice(-12).map(({ role, text }) => ({ role, text })), labels: [...labels], humanEverReplied, humanRepliedAfterBot: humanEverReplied, previousAgentDraft, contactHash: 'synthetic-contact', contactPhone: '+4915112345678', documentAssistanceActive: effects.some(effect => effect.kind === 'document_assistance_note' && effect.id < input.currentMessageId) }
      },
      async loadCurrentSource(input) {
        if (!current || current.id !== input.currentMessageId) return undefined
        return { content: current.content, executionContext: { accountId: tenant.accountId, inboxId: tenant.inboxId, conversationId: current.conversation.id, sourceMessageId: current.id, contactId: 777, sourceChannel: 'whatsapp', sourceReceivedAt: current.created_at, mode: 'customer_message' } }
      },
    },
    conversationLock: { async runExclusive(_tenant, _conversation, operation) { return operation() } },
    pseudonymizationKey: PSEUDONYMIZATION_KEY,
    autoSendEnabled: true,
    autoSendLimits: { maxPerConversation: options.cap ?? 3, maxPerContactPerHour: 10 },
    whatsappInboxIds: new Set([tenant.inboxId]),
  })
  function receive(text: string) {
    const id = nextId++
    current = incomingPayload({ id, content: text, account: { id: tenant.accountId }, inboxId: tenant.inboxId, created_at: new Date(Date.UTC(2026, 8, 19, 12, 0, id - 100)).toISOString() })
    transcript.push({ id, role: 'customer', text })
    return current
  }
  return {
    requests, effects, reservations, deliveries,
    receive,
    async process(payload: ChatwootWebhookPayload, brain: SupportBrainPort['answer']) { nextBrain = brain; await processor.process({ tenant, payload }) },
    async turn(text: string, brain: SupportBrainPort['answer']) { const payload = receive(text); nextBrain = brain; await processor.process({ tenant, payload }); return payload },
    human(text: string) { humanEverReplied = true; transcript.push({ id: nextId - 0.25, role: 'human', text }) },
    publicTexts: () => effects.filter(effect => effect.kind === 'answer' || effect.kind === 'handoff_ack').map(effect => effect.text),
    status: () => ({ handedOff, blocked, composer }),
  }
}

function answer(text: string, extra: Partial<SupportBrainAnswer> = {}): SupportBrainAnswer {
  return { action: 'answer', text, confidence: 1, sources: [{ title: 'Synthetic approved knowledge', url: 'https://example.invalid/help' }], safeToAutoSend: true, ...extra }
}
function automated(request: SupportBrainRequest, kind: NonNullable<SupportBrainAnswer['automation']>['kind'], reason: string, text: string, action: 'answer' | 'clarify' = 'answer') {
  if (!request.executionContext) throw new Error('Missing verified source')
  return answer(text, { action, sources: [], reason, automation: { version: 1, kind, requestId: request.requestId, sourceMessageId: request.executionContext.sourceMessageId } })
}

describe('stateful customer conversation simulation', () => {
  it('carries an answer into a follow-up clarification, without repeating delivery on webhook replay', async () => {
    const c = conversation()
    await c.turn('Wo finde ich meine Kurse?', async () => answer('Im Academy-Menü unter Kurse.'))
    const question = await c.turn('Und wo kann ich den Termin sehen?', async request => {
      expect(request.history).toContainEqual({ role: 'agent', text: 'Im Academy-Menü unter Kurse.' })
      return automated(request, 'calendar_clarification', 'calendar_action_clarify', 'Meinst du deinen Beratungstermin?', 'clarify')
    })
    await c.process(question, async () => { throw new Error('Replay must not regenerate') })
    await c.turn('Ja, den Beratungstermin.', async request => automated(request, 'calendar_status', 'autonomy:calendar_status', 'Dein bestätigter Termin ist Montag um 14 Uhr.'))
    expect(c.publicTexts()).toEqual(['Im Academy-Menü unter Kurse.', 'Meinst du deinen Beratungstermin?', 'Dein bestätigter Termin ist Montag um 14 Uhr.'])
    expect(c.requests).toHaveLength(3)
    expect(c.status().handedOff).toBe(false)
  })

  it('keeps document verification and scripted grant facts private from learning across three turns', async () => {
    const c = conversation(); let grant = false
    await c.turn('Bitte meine Rechnung.', async request => automated(request, 'document_verification', 'document_assistance:verification_required', 'Bitte bestätige deine E-Mail im geschützten Portal.'))
    await c.turn('123456', async request => {
      expect(grant).toBe(false)
      return automated(request, 'document_access', 'document_assistance:code_in_chat', 'Gib den Code bitte ausschließlich im geschützten Portal ein.')
    })
    expect(c.publicTexts().join(' ')).not.toContain('Rechnung A-123')
    grant = true // Website grant/OTP correctness belongs to its dedicated tests.
    await c.turn('Im Portal bestätigt. Welche Rechnung ist offen?', async request => {
      expect(grant).toBe(true)
      return automated(request, 'document_access', 'document_assistance:invoices', 'Deine Rechnung A-123 ist offen. Details stehen im geschützten Portal.')
    })
    expect(c.publicTexts()).toHaveLength(3)
    expect(c.publicTexts()[2]).toContain('Rechnung A-123')
    expect(c.reservations.size).toBe(3)
    for (const reservation of c.reservations.values()) {
      expect(reservation.sensitive).toBe(true)
      expect(reservation.sourceIds).toEqual([])
      expect(c.effects.findIndex(effect => effect.id === reservation.messageId && effect.kind === 'document_assistance_note')).toBeLessThan(c.effects.findIndex(effect => effect.id === reservation.messageId && effect.kind === 'answer'))
    }
  })

  it.each(['Welche Rechnung eines fremden Kunden ist offen?', 'Bitte erstatte meine Rechnung.', 'Bitte bezahle meine Rechnung.', 'Meine Rechnung kündigen', 'Welche Rechnung ist für Peter offen?'])('does not widen a document continuation into billing actions or third-party access: %s', async text => {
    const c = conversation()
    await c.turn('Bitte meine Rechnung.', async request => automated(request, 'document_verification', 'document_assistance:verification_required', 'Bitte im geschützten Portal bestätigen.'))
    const calls = c.requests.length
    await c.turn(text, async () => { throw new Error('Must remain a handoff') })
    expect(c.requests).toHaveLength(calls)
    expect(c.status().handedOff).toBe(true)
  })
  it('does not treat an unbound invoice-status question as an active document sequence', async () => {
    const c = conversation()
    await c.turn('Welche Rechnung ist offen?', async () => { throw new Error('No active document flow') })
    expect(c.requests).toHaveLength(0)
    expect(c.status().handedOff).toBe(true)
  })

  it('drops an in-flight obsolete reply and answers only the newer correction', async () => {
    const c = conversation(); let corrected: ChatwootWebhookPayload | undefined
    await c.turn('Ich meinte Montag für den Termin.', async () => {
      corrected = c.receive('Korrektur: Ich meinte Dienstag für den Termin.')
      return answer('Du meinst Montag.')
    })
    expect(c.publicTexts()).toEqual([])
    expect(c.status().handedOff).toBe(false)
    await c.process(corrected!, async request => {
      expect(request.question).toContain('Dienstag')
      return automated(request, 'calendar_clarification', 'calendar_action_clarify', 'Welche Uhrzeit passt dir am Dienstag?', 'clarify')
    })
    expect(c.publicTexts()).toEqual(['Welche Uhrzeit passt dir am Dienstag?'])
  })

  it('keeps explicit human handoff sticky across later routine questions', async () => {
    const c = conversation()
    await c.turn('Wo sind die Lernvideos?', async () => answer('Unter Kurse.'))
    await c.turn('Ich möchte einen Menschen sprechen.', async () => { throw new Error('Human request must bypass Brain') })
    c.human('Ich kümmere mich persönlich darum.')
    await c.turn('Wo waren die Videos nochmal?', async request => {
      expect(request.reviewOnly).toBe(true)
      return answer('Unter Kurse.')
    })
    expect(c.publicTexts()).toHaveLength(2) // Initial answer and one handoff acknowledgement.
    expect(c.effects.filter(effect => effect.kind === 'answer')).toHaveLength(1)
    expect(c.status()).toMatchObject({ handedOff: true, blocked: true, composer: 'Unter Kurse.' })
  })

  it('does not consume cap3 for a review draft, but exposes the lifetime cap on a fourth legitimate follow-up', async () => {
    const c = conversation()
    await c.turn('Ich brauche Informationen zu diesem Punkt.', async () => answer('Welchen Kurs meinst du?', { action: 'clarify', safeToAutoSend: false }))
    expect(c.status().handedOff).toBe(false)
    expect(c.reservations.size).toBe(0)
    for (const [question, response] of [['Wo ist Kurs A?', 'Unter Kurse.'], ['Und die Übungen?', 'Unter Übungen.'], ['Und die Aufzeichnung?', 'Unter Aufzeichnungen.']]) {
      await c.turn(question!, async () => answer(response!))
    }
    expect(c.publicTexts()).toEqual(['Unter Kurse.', 'Unter Übungen.', 'Unter Aufzeichnungen.'])
    expect(c.status().handedOff).toBe(false)
    await c.turn('Und mein Teilnahmezertifikat?', async () => answer('Unter Zertifikate.'))
    expect(c.publicTexts()).toHaveLength(3)
    expect(c.status().handedOff).toBe(true)
    expect(c.effects.some(effect => effect.text.includes('conversation_limit'))).toBe(true)
  })

  it('with runtime cap20 sends four legitimate turns and still blocks the eleventh within one hour', async () => {
    const c = conversation({ cap: 20 })
    // All synthetic source timestamps are one second apart within the same hour.
    for (let turn = 1; turn <= 4; turn++) await c.turn(`Wo finde ich Abschnitt ${turn}?`, async () => answer(`Abschnitt ${turn} steht unter Kurse.`))
    expect(c.publicTexts()).toHaveLength(4)
    expect(c.status().handedOff).toBe(false)
    for (let turn = 5; turn <= 10; turn++) await c.turn(`Wo finde ich Abschnitt ${turn}?`, async () => answer(`Abschnitt ${turn} steht unter Kurse.`))
    expect(c.publicTexts()).toHaveLength(10)
    expect(c.status().handedOff).toBe(false)
    await c.turn('Wo finde ich Abschnitt 11?', async () => answer('Abschnitt 11 steht unter Kurse.'))
    expect(c.publicTexts()).toHaveLength(10)
    expect(c.reservations.size).toBe(10)
    expect(c.effects.some(effect => effect.text.includes('contact_rate_limit'))).toBe(true)
    expect(c.status().handedOff).toBe(true)
  })

  it('continues internal reviews for a legacy handoff without silently clearing its human ownership', async () => {
    const c = conversation({ alreadyHandedOff: true })
    await c.turn('Wo finde ich Kurs A?', async request => { expect(request.reviewOnly).toBe(true); return answer('Unter Kurse.') })
    await c.turn('Wo finde ich die Aufzeichnung?', async request => { expect(request.reviewOnly).toBe(true); return answer('Unter Aufzeichnungen.') })
    expect(c.publicTexts()).toEqual([])
    expect(c.status()).toMatchObject({ handedOff: true, blocked: true, composer: 'Unter Aufzeichnungen.' })
    expect(c.requests[1]?.history.some(turn => turn.role === 'agent')).toBe(false)
    expect(c.reservations.size).toBe(0)
  })
})
