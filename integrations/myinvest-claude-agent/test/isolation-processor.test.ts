import { describe, expect, it, vi } from 'vitest'
import {
  questionFingerprint,
  type AutoSendLimits,
  type AutoSendUsage,
} from '../src/auto-send.js'
import type { ConversationContext } from '../src/domain.js'
import { PostgresKnowledgeRepository } from '../src/knowledge/repository.js'
import { MessageProcessor } from '../src/processor.js'
import type { SupportBrainAnswer } from '../src/support-brain.js'
import { incomingPayload, tenants } from './fixtures.js'

describe('knowledge isolation', () => {
  it('binds tenant_key and never widens an empty result', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const repository = new PostgresKnowledgeRepository({ query })
    expect(await repository.search('new_academy', 'Provision', 4)).toEqual([])
    expect(query.mock.calls[0]![0]).toContain('tenant_key = $1')
    expect(query.mock.calls[0]![0]).toContain("publication_status = 'published'")
    expect(query.mock.calls[0]![0]).toContain('active = true')
    expect(query.mock.calls[0]![1]).toEqual(['new_academy', 'Provision', 4])
    // OR-Fallback bei leerem Ergebnis bleibt strikt tenant-gebunden.
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0]).toContain('tenant_key = $1')
    expect(query.mock.calls[1]![0]).toContain("publication_status = 'published'")
    expect(query.mock.calls[1]![0]).toContain('active = true')
    expect(query.mock.calls[1]![1]).toEqual(['new_academy', 'Provision', 4])
  })
})

/**
 * Antwort der Gehirn-API. `safeToAutoSend: false` ist der Vorgabefall: das
 * Serverurteil muss aktiv positiv sein, sonst bleibt es beim Entwurf.
 */
const BRAIN_ANSWER: SupportBrainAnswer = {
  action: 'answer',
  text: 'Du startest mit der Kontoeinrichtung.',
  confidence: 0.82,
  sources: [{ title: 'Onboarding', url: 'https://hilfe.example.invalid/onboarding' }],
  safeToAutoSend: false,
}
const SAFE_ANSWER: SupportBrainAnswer = { ...BRAIN_ANSWER, safeToAutoSend: true }
/** Pseudonym des Kontakts, wie es der Kontext-Store liefert. */
const CONTACT_HASH = 'f'.repeat(64)
const LIMITS: AutoSendLimits = { maxPerConversation: 3, maxPerContactPerHour: 10 }

function setup(
  options: {
    answer?: SupportBrainAnswer
    context?: Partial<ConversationContext>
    usage?: Partial<AutoSendUsage>
    autoSendEnabled?: boolean
    limits?: AutoSendLimits
  } = {},
) {
  // Reihenfolge der beiden gefaehrlichen Schritte: die Audit-Zeile muss vor
  // der Kundennachricht stehen.
  const sequence: string[] = []
  const answer = vi.fn().mockResolvedValue(options.answer ?? BRAIN_ANSWER)
  const sendMessage = vi.fn(async () => {
    sequence.push('send')
  })
  const saveDraft = vi.fn().mockResolvedValue(undefined)
  const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
  const setPriority = vi.fn().mockResolvedValue(undefined)
  const addLabels = vi.fn().mockResolvedValue(undefined)
  const assign = vi.fn().mockResolvedValue(undefined)
  const handoff = vi.fn().mockResolvedValue(undefined)
  const loadContext = vi.fn().mockResolvedValue({
    turns: [],
    labels: [],
    humanRepliedAfterBot: false,
    humanEverReplied: false,
    contactHash: CONTACT_HASH,
    ...options.context,
  })
  const usage = vi.fn().mockResolvedValue({
    blocked: false,
    conversationCount: 0,
    contactCountLastHour: 0,
    ...options.usage,
  })
  const blockConversation = vi.fn().mockResolvedValue(undefined)
  const record = vi.fn(async () => {
    sequence.push('record')
  })
  const markSent = vi.fn(async () => {
    sequence.push('mark-sent')
  })
  const state = {
    isHandedOff: vi.fn().mockResolvedValue(false),
    activateConversation: vi.fn().mockResolvedValue(undefined),
    beginDelivery: vi.fn().mockResolvedValue({ status: 'processing', acquired: true }),
    markSending: vi.fn().mockResolvedValue(undefined),
    completeReply: vi.fn().mockResolvedValue(undefined),
    completeHandoff: vi.fn().mockResolvedValue(undefined),
    failDelivery: vi.fn().mockResolvedValue(undefined),
  }
  const processor = new MessageProcessor({
    brain: { answer },
    chatwoot: { sendMessage, sendPrivateNote, saveDraft, setPriority, addLabels, assign, handoff },
    context: { loadContext },
    state,
    autoSend: { usage, blockConversation, record, markSent },
    autoSendEnabled: options.autoSendEnabled ?? false,
    autoSendLimits: options.limits ?? LIMITS,
    whatsappInboxIds: new Set([6]),
  })
  return {
    processor,
    answer,
    saveDraft,
    sendMessage,
    sendPrivateNote,
    setPriority,
    addLabels,
    assign,
    handoff,
    loadContext,
    state,
    autoSend: { usage, blockConversation, record, markSent },
    sequence,
  }
}

describe('MessageProcessor', () => {
  it('uses only the configured tenant and hands off unsafe or brain-declined questions', async () => {
    const supported = setup()
    await supported.processor.process({
      tenant: tenants[1]!,
      payload: incomingPayload({ account: { id: 202 } }),
    })
    expect(supported.answer).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: 'new_academy', channel: 'web' }),
    )
    expect(supported.autoSend.usage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'new_academy', messageId: 55 }),
    )
    expect(supported.saveDraft).toHaveBeenCalledWith(tenants[1], 77, BRAIN_ANSWER.text)
    expect(supported.sendMessage).not.toHaveBeenCalled()
    expect(supported.state.completeHandoff).toHaveBeenCalledWith('new_academy', 55, 77)

    for (const content of [
      'Ich möchte mit einem Menschen sprechen.',
      'Ist diese Klausel rechtlich wirksam?',
      'Wie bezahle ich die Rechnung?',
      'Welche Anlage bringt die beste Rendite und wie versteuere ich sie?',
    ]) {
      const unsafe = setup()
      await unsafe.processor.process({ tenant: tenants[0]!, payload: incomingPayload({ content }) })
      expect(unsafe.answer).not.toHaveBeenCalled()
      expect(unsafe.handoff).toHaveBeenCalledOnce()
      expect(unsafe.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
    }

    // Die Gehirn-API darf selbst uebergeben. Der Fall geht sichtbar an einen
    // Menschen und dessen Composer bekommt denselben Text als Entwurf.
    const declined = setup({
      answer: { ...BRAIN_ANSWER, action: 'handoff', reason: 'kein Beleg im Wissen' },
    })
    await declined.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(declined.saveDraft).toHaveBeenCalledWith(tenants[0], 77, BRAIN_ANSWER.text)
    expect(declined.addLabels).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.arrayContaining(['ki-entwurf']),
    )
    expect(declined.handoff).toHaveBeenCalledOnce()
    expect(declined.sendMessage).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Kollegen'),
      55,
      'handoff_ack',
    )
  })

  it('answers a presence check naturally through the guarded auto-send path', async () => {
    const presence = setup({ autoSendEnabled: true })
    await presence.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Ist jemand hier ?' }),
    })

    expect(presence.answer).not.toHaveBeenCalled()
    expect(presence.autoSend.record).toHaveBeenCalledOnce()
    expect(presence.sequence).toEqual(['record', 'send', 'mark-sent'])
    expect(presence.setPriority).not.toHaveBeenCalled()
    expect(presence.handoff).not.toHaveBeenCalled()
    expect(presence.sendMessage).toHaveBeenCalledWith(
      tenants[0],
      77,
      'Hey, ja — wir sind da. Wie können wir dir helfen?',
      55,
      'answer',
    )
    expect(presence.state.completeReply).toHaveBeenCalledWith('saas', 55)
  })

  it('laesst auch die deterministische Begruessung bei ausgeschaltetem Kill-Switch nur als Entwurf zu', async () => {
    const presence = setup()

    await presence.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Ist jemand hier?' }),
    })

    expect(presence.answer).not.toHaveBeenCalled()
    expect(presence.sendMessage).not.toHaveBeenCalled()
    expect(presence.autoSend.record).not.toHaveBeenCalled()
    expect(presence.saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      'Hey, ja — wir sind da. Wie können wir dir helfen?',
    )
    expect(presence.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('resumes after a human reply and drafts the brain clarification', async () => {
    const clarification =
      'Klar, ich schaue mir das an. Wie heißt du und mit welcher E-Mail-Adresse bist du registriert?'
    const thread = setup({
      answer: {
        action: 'clarify',
        text: clarification,
        confidence: 0.35,
        sources: [],
        safeToAutoSend: false,
      },
      context: {
        turns: [
          { role: 'assistant', text: 'Danke für deine Nachricht. Ein Kollege meldet sich.' },
          { role: 'human', text: 'Hallo, wie können wir helfen?' },
          {
            role: 'customer',
            text: 'Ich habe die Änderung der Bank bestätigt. Mir wurden zwei Leads versprochen.',
          },
        ],
        labels: ['ki-uebergabe'],
        humanRepliedAfterBot: true,
      },
    })
    thread.state.isHandedOff.mockResolvedValueOnce(true)

    await thread.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Die möchte ich gerne haben :)' }),
    })

    expect(thread.state.activateConversation).toHaveBeenCalledWith('saas', 77)
    // Der Agent transportiert die aktuelle Frage und den redigierten Verlauf —
    // und sonst nichts.
    expect(thread.answer).toHaveBeenCalledWith({
      question: 'Die möchte ich gerne haben :)',
      history: [
        { role: 'agent', text: 'Danke für deine Nachricht. Ein Kollege meldet sich.' },
        { role: 'agent', text: 'Hallo, wie können wir helfen?' },
        {
          role: 'user',
          text: 'Ich habe die Änderung der Bank bestätigt. Mir wurden zwei Leads versprochen.',
        },
      ],
      tenant: 'saas',
      channel: 'web',
    })
    expect(thread.saveDraft).toHaveBeenCalledWith(tenants[0], 77, clarification)
    expect(thread.sendMessage).not.toHaveBeenCalled()
    expect(thread.addLabels).toHaveBeenCalledWith(tenants[0], 77, ['ki-entwurf'])
    expect(thread.assign).toHaveBeenCalledWith(tenants[0], 77, tenants[0]!.handoffAssigneeId)
    expect(thread.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Antwortvorschlag'),
      55,
      'clarify_draft_note',
    )
    expect(thread.handoff).toHaveBeenCalledOnce()
    expect(thread.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('keeps sensitive and explicit-human handoffs under human control', async () => {
    for (const label of ['zahlung', 'mensch-gewuenscht']) {
      const blocked = setup({
        context: {
          turns: [{ role: 'human', text: 'Ich übernehme den Fall.' }],
          labels: ['ki-uebergabe', label],
          humanRepliedAfterBot: true,
        },
      })
      blocked.state.isHandedOff.mockResolvedValueOnce(true)
      await blocked.processor.process({
        tenant: tenants[0]!,
        payload: incomingPayload({ content: 'Gibt es schon etwas Neues?' }),
      })
      expect(blocked.state.activateConversation).not.toHaveBeenCalled()
      expect(blocked.answer).toHaveBeenCalled()
      expect(blocked.saveDraft).toHaveBeenCalledWith(
        tenants[0],
        77,
        BRAIN_ANSWER.text,
      )
      expect(blocked.sendMessage).not.toHaveBeenCalled()
    }
  })

  it('keeps drafting handed-off conversations while suppressing public replies', async () => {
    const handedOff = setup()
    handedOff.state.isHandedOff.mockResolvedValueOnce(true)
    await handedOff.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(handedOff.answer).toHaveBeenCalled()
    expect(handedOff.saveDraft).toHaveBeenCalledWith(tenants[0], 77, BRAIN_ANSWER.text)
    expect(handedOff.sendMessage).not.toHaveBeenCalled()
    expect(handedOff.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })


  it('laesst auch eine sichere Antwort nach einer Uebergabe nur im Composer', async () => {
    const handedOff = setup({ answer: SAFE_ANSWER, autoSendEnabled: true })
    handedOff.state.isHandedOff.mockResolvedValueOnce(true)

    await handedOff.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload(),
    })

    expect(handedOff.answer).toHaveBeenCalledOnce()
    expect(handedOff.saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      SAFE_ANSWER.text,
    )
    expect(handedOff.sendMessage).not.toHaveBeenCalled()
    expect(handedOff.autoSend.record).not.toHaveBeenCalled()
  })
  it('legt fuer eine Finanzierungsfrage im bereits uebergebenen Chat einen internen Vorschlag an', async () => {
    const handedOff = setup({ autoSendEnabled: true, answer: SAFE_ANSWER })
    handedOff.state.isHandedOff.mockResolvedValueOnce(true)

    await handedOff.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({
        content: 'Finanzierung, wie es sich verhält mit Eigenkapital.',
      }),
    })

    expect(handedOff.answer).not.toHaveBeenCalled()
    expect(handedOff.saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('von deiner Situation abhängt'),
    )
    expect(handedOff.addLabels).toHaveBeenCalledWith(tenants[0], 77, [
      'ki-entwurf',
      'ki-uebergabe',
      'beratung',
    ])
    expect(handedOff.sendMessage).not.toHaveBeenCalled()
    expect(handedOff.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('suppresses terminal and concurrently owned deliveries without side effects', async () => {
    for (const status of ['replied', 'handed_off', 'processing', 'sending'] as const) {
      const duplicate = setup({ autoSendEnabled: true, answer: SAFE_ANSWER })
      duplicate.state.beginDelivery.mockResolvedValueOnce({ status, acquired: false })
      await duplicate.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
      expect(duplicate.sendMessage).not.toHaveBeenCalled()
      expect(duplicate.autoSend.record).not.toHaveBeenCalled()
      expect(duplicate.setPriority).not.toHaveBeenCalled()
      expect(duplicate.handoff).not.toHaveBeenCalled()
      expect(duplicate.state.completeHandoff).not.toHaveBeenCalled()
    }
  })

  it('keeps sources internal and puts the answer into the human composer', async () => {
    const selected = setup({
      answer: {
        ...BRAIN_ANSWER,
        text: 'Antwort',
        sources: [{ title: 'Quelle Zwei', url: 'https://hilfe.example.invalid/zwei' }],
      },
    })
    await selected.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(selected.saveDraft).toHaveBeenCalledWith(tenants[0], 77, 'Antwort')
    expect(selected.sendMessage).not.toHaveBeenCalled()
    expect(selected.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Quelle Zwei (https://hilfe.example.invalid/zwei)'),
      55,
      'draft_note',
    )
    // Der Composer bekommt genau den Antworttext; Belege bleiben intern.
    expect(selected.saveDraft.mock.calls[0]![2]).not.toContain('hilfe.example.invalid')
    expect(selected.addLabels).toHaveBeenCalledWith(tenants[0], 77, ['ki-entwurf'])
    expect(selected.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('escalates a critical report with priority, labels, note, assignment and a visible reply', async () => {
    const critical = setup()
    const content =
      'Mein Kunde wurde von einem fremden Finanzierer angeschrieben, der einen KI Avatar verwendet und keinen Datenschutzlink hat.'
    await critical.processor.process({ tenant: tenants[0]!, payload: incomingPayload({ content }) })

    expect(critical.answer).not.toHaveBeenCalled()
    expect(critical.setPriority).toHaveBeenCalledWith(tenants[0], 77, 'urgent')
    expect(critical.addLabels).toHaveBeenCalledWith(tenants[0], 77, ['ki-uebergabe', 'sicherheitsverdacht'])
    expect(critical.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('triage_sicherheit'),
      55,
      'handoff_note',
    )
    expect(critical.assign).toHaveBeenCalledWith(tenants[0], 77, tenants[0]!.handoffAssigneeId)
    expect(critical.handoff).toHaveBeenCalledOnce()
    expect(critical.sendMessage).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('als dringend markiert'),
      55,
      'handoff_ack',
    )
    expect(critical.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('attempts every escalation step but never records an incomplete handoff as terminal', async () => {
    const flaky = setup()
    flaky.setPriority.mockRejectedValueOnce(new Error('toggle_priority returned 404'))
    flaky.addLabels.mockRejectedValueOnce(new Error('labels returned 403'))
    flaky.handoff.mockRejectedValueOnce(new Error('toggle_status returned 404'))

    await expect(
      flaky.processor.process({
        tenant: tenants[0]!,
        payload: incomingPayload({ content: 'Ich will mit einem Menschen sprechen.' }),
      }),
    ).rejects.toThrow(/escalation is incomplete/i)

    expect(flaky.sendPrivateNote).toHaveBeenCalledOnce()
    expect(flaky.assign).toHaveBeenCalledOnce()
    expect(flaky.sendMessage).toHaveBeenCalledOnce()
    expect(flaky.state.completeHandoff).not.toHaveBeenCalled()
  })

  it('retries advisory side effects, then preserves a visible handoff on the final attempt', async () => {
    const retry = setup()
    retry.setPriority.mockRejectedValueOnce(new Error('toggle_priority returned 503'))
    await expect(
      retry.processor.process({
        tenant: tenants[0]!,
        payload: incomingPayload({ content: 'Ich will mit einem Menschen sprechen.' }),
        isFinalAttempt: false,
      }),
    ).rejects.toThrow(/escalation is incomplete/i)
    expect(retry.state.completeHandoff).not.toHaveBeenCalled()

    const finalAttempt = setup()
    finalAttempt.setPriority.mockRejectedValueOnce(new Error('toggle_priority returned 403'))
    await finalAttempt.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Ich will mit einem Menschen sprechen.' }),
      isFinalAttempt: true,
    })
    expect(finalAttempt.sendPrivateNote).toHaveBeenCalledOnce()
    expect(finalAttempt.sendMessage).toHaveBeenCalledOnce()
    expect(finalAttempt.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('falls back to a visible human handoff when draft preparation fails finally', async () => {
    const draftFailure = setup()
    draftFailure.saveDraft.mockRejectedValueOnce(new Error('draft endpoint unavailable'))

    await draftFailure.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload(),
      isFinalAttempt: true,
    })

    expect(draftFailure.setPriority).toHaveBeenCalled()
    expect(draftFailure.assign).toHaveBeenCalled()
    expect(draftFailure.handoff).toHaveBeenCalled()
    expect(draftFailure.sendMessage).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Kollegen'),
      55,
      'handoff_ack',
    )
    expect(draftFailure.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('does not send a customer message when draft ledger completion fails', async () => {
    const ledgerFailure = setup()
    ledgerFailure.state.completeHandoff.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(
      ledgerFailure.processor.process({ tenant: tenants[0]!, payload: incomingPayload() }),
    ).rejects.toThrow(/database unavailable/)

    expect(ledgerFailure.saveDraft).toHaveBeenCalledTimes(1)
    expect(ledgerFailure.saveDraft).toHaveBeenCalledWith(tenants[0], 77, BRAIN_ANSWER.text)
    expect(ledgerFailure.sendMessage).not.toHaveBeenCalled()
    expect(ledgerFailure.setPriority).not.toHaveBeenCalled()
  })
})

/**
 * Der gefaehrlichste Pfad: hier verlaesst eine Antwort das Haus, ohne dass ein
 * Mensch sie gelesen hat. Geprueft wird beobachtbares Verhalten — was beim
 * Kunden ankommt und was in der Audit-Spur steht.
 */
describe('MessageProcessor auto-send', () => {
  it('sends automatically only when the brain marks the answer safe and answerable', async () => {
    const sent = setup({ autoSendEnabled: true, answer: SAFE_ANSWER })
    await sent.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })

    expect(sent.sendMessage).toHaveBeenCalledWith(tenants[0], 77, SAFE_ANSWER.text, 55, 'answer')
    expect(sent.saveDraft).not.toHaveBeenCalled()
    expect(sent.addLabels).toHaveBeenCalledWith(tenants[0], 77, ['ki-antwort'])
    expect(sent.state.markSending).toHaveBeenCalledWith('saas', 55)
    expect(sent.state.completeReply).toHaveBeenCalledWith('saas', 55)
    // Eine automatische Antwort uebergibt das Gespraech nicht zusaetzlich.
    expect(sent.assign).not.toHaveBeenCalled()
    expect(sent.handoff).not.toHaveBeenCalled()
    expect(sent.state.completeHandoff).not.toHaveBeenCalled()
    // Belege stehen in der internen Notiz, nie in der Kundenantwort.
    expect(sent.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('https://hilfe.example.invalid/onboarding'),
      55,
      'answer_sources',
    )
    expect(sent.sendMessage.mock.calls[0]![2]).not.toContain('hilfe.example.invalid')

    // Serverurteil negativ oder keine Antwort-Aktion: nur Entwurf.
    for (const answer of [
      { ...SAFE_ANSWER, safeToAutoSend: false },
      { ...SAFE_ANSWER, action: 'clarify' as const },
    ]) {
      const drafted = setup({ autoSendEnabled: true, answer })
      await drafted.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
      expect(drafted.sendMessage).not.toHaveBeenCalled()
      expect(drafted.autoSend.record).not.toHaveBeenCalled()
      expect(drafted.saveDraft).toHaveBeenCalledWith(tenants[0], 77, SAFE_ANSWER.text)
      expect(drafted.sendPrivateNote).toHaveBeenCalledWith(
        tenants[0],
        77,
        expect.stringContaining('brain_declined'),
        55,
        expect.any(String),
      )
    }
  })

  it('bindet Werkzeuge an die signierte Chatwoot-Kontaktadresse', async () => {
    const withContact = setup({
      answer: SAFE_ANSWER,
      context: { contactEmail: 'kunde@example.de' },
    })

    await withContact.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Ist mein App-Zugang aktiv?' }),
    })

    expect(withContact.answer).toHaveBeenCalledWith(
      expect.objectContaining({ contact: { email: 'kunde@example.de' } }),
    )
  })

  it('drafts instead of sending while the kill switch is off', async () => {
    const off = setup({ autoSendEnabled: false, answer: SAFE_ANSWER })
    await off.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })

    expect(off.sendMessage).not.toHaveBeenCalled()
    expect(off.autoSend.record).not.toHaveBeenCalled()
    expect(off.saveDraft).toHaveBeenCalledWith(tenants[0], 77, SAFE_ANSWER.text)
    // Der Grund steht in der internen Notiz, damit ein Mensch es einordnet.
    expect(off.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('kill_switch_off'),
      55,
      'draft_note',
    )
    expect(off.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('never auto-sends again once a human wrote in the conversation', async () => {
    const afterHuman = setup({
      autoSendEnabled: true,
      answer: SAFE_ANSWER,
      context: {
        turns: [
          { role: 'customer', text: 'Mir wurden zwei Leads versprochen.' },
          {
            role: 'human',
            text: 'Wie heißt du und mit welcher E-Mail-Adresse bist du registriert?',
          },
        ],
        labels: ['ki-entwurf'],
        humanRepliedAfterBot: true,
      },
    })
    await afterHuman.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Wie erstelle ich meinen ersten Kontakt?' }),
    })

    // Die Sperre wird persistiert, nicht nur im Verlauf erkannt.
    expect(afterHuman.autoSend.blockConversation).toHaveBeenCalledWith({
      tenantKey: 'saas',
      conversationId: 77,
      reason: 'human_reply',
    })
    expect(afterHuman.sendMessage).not.toHaveBeenCalled()
    expect(afterHuman.autoSend.record).not.toHaveBeenCalled()
    expect(afterHuman.saveDraft).toHaveBeenCalledWith(tenants[0], 77, SAFE_ANSWER.text)
    // Neues Thema: gefragt wird die aktuelle Nachricht, der Verlauf ist Kontext.
    expect(afterHuman.answer).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Wie erstelle ich meinen ersten Kontakt?' }),
    )

    // Neustart: das Verlaufsfenster reicht nur 12 Nachrichten weit, die
    // persistierte Sperre entscheidet trotzdem.
    const afterRestart = setup({
      autoSendEnabled: true,
      answer: SAFE_ANSWER,
      usage: { blocked: true },
    })
    await afterRestart.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(afterRestart.autoSend.blockConversation).not.toHaveBeenCalled()
    expect(afterRestart.sendMessage).not.toHaveBeenCalled()
    expect(afterRestart.autoSend.record).not.toHaveBeenCalled()
    expect(afterRestart.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('human_in_conversation'),
      55,
      'draft_note',
    )
  })

  it('wendet den Human-Lock auch auf deterministische Begruessungen an', async () => {
    const afterHuman = setup({
      autoSendEnabled: true,
      answer: SAFE_ANSWER,
      context: {
        turns: [{ role: 'human', text: 'Ich uebernehme das hier.' }],
      },
    })


    await afterHuman.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Ist jemand hier?' }),
    })

    expect(afterHuman.autoSend.blockConversation).toHaveBeenCalledWith({
      tenantKey: 'saas',
      conversationId: 77,
      reason: 'human_reply',
    })
    expect(afterHuman.sendMessage).not.toHaveBeenCalled()
    expect(afterHuman.answer).toHaveBeenCalled()
    expect(afterHuman.saveDraft).toHaveBeenCalled()
  })
  it('blockiert auch eine Menschenantwort ausserhalb des Verlaufsfensters', async () => {
    const historicHuman = setup({
      autoSendEnabled: true,
      answer: SAFE_ANSWER,
      context: { turns: [], humanEverReplied: true },
    })

    await historicHuman.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Wie erstelle ich einen Kontakt?' }),
    })

    expect(historicHuman.autoSend.blockConversation).toHaveBeenCalledWith({
      tenantKey: 'saas',
      conversationId: 77,
      reason: 'human_reply',
    })
    expect(historicHuman.sendMessage).not.toHaveBeenCalled()
    expect(historicHuman.saveDraft).toHaveBeenCalled()
  })

  it('stops at the conversation limit, the contact rate limit, and the length guard', async () => {
    const cases = [
      { verdict: 'conversation_limit', options: { usage: { conversationCount: 3 } } },
      { verdict: 'contact_rate_limit', options: { usage: { contactCountLastHour: 10 } } },
      { verdict: 'text_too_long', options: { answer: { ...SAFE_ANSWER, text: 'A'.repeat(1_201) } } },
    ]
    for (const { verdict, options } of cases) {
      const limited = setup({ autoSendEnabled: true, answer: SAFE_ANSWER, ...options })
      await limited.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
      expect(limited.sendMessage).not.toHaveBeenCalled()
      expect(limited.autoSend.record).not.toHaveBeenCalled()
      expect(limited.sendPrivateNote).toHaveBeenCalledWith(
        tenants[0],
        77,
        expect.stringContaining(verdict),
        55,
        'draft_note',
      )
    }

    // Direkt unter beiden Grenzen geht die Antwort raus.
    const lastAllowed = setup({
      autoSendEnabled: true,
      answer: SAFE_ANSWER,
      usage: { conversationCount: 2, contactCountLastHour: 9 },
    })
    await lastAllowed.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(lastAllowed.sendMessage).toHaveBeenCalledWith(
      tenants[0],
      77,
      SAFE_ANSWER.text,
      55,
      'answer',
    )
  })

  it('records every automatically sent answer before it leaves the house', async () => {
    const audited = setup({ autoSendEnabled: true, answer: SAFE_ANSWER })
    await audited.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })

    expect(audited.autoSend.record).toHaveBeenCalledWith({
      tenantKey: 'saas',
      conversationId: 77,
      messageId: 55,
      contactHash: CONTACT_HASH,
      questionHash: questionFingerprint('saas', 'Wie funktioniert das Onboarding?'),
      confidence: SAFE_ANSWER.confidence,
      sourceIds: ['https://hilfe.example.invalid/onboarding'],
      sentText: SAFE_ANSWER.text,
    })
    // Der Fragetext selbst wird nie auditiert, nur sein Fingerabdruck.
    expect(JSON.stringify(audited.autoSend.record.mock.calls[0])).not.toContain(
      'Wie funktioniert das Onboarding',
    )
    // Audit-Versuch vor dem Send; `sent_at` erst NACH bestaetigtem Send.
    expect(audited.sequence).toEqual(['record', 'send', 'mark-sent'])
    expect(audited.autoSend.markSent).toHaveBeenCalledWith('saas', 55)

    // Ohne Audit-Zeile geht nichts raus.
    const auditFailure = setup({ autoSendEnabled: true, answer: SAFE_ANSWER })
    auditFailure.autoSend.record.mockRejectedValueOnce(new Error('audit log unavailable'))
    await expect(
      auditFailure.processor.process({ tenant: tenants[0]!, payload: incomingPayload() }),
    ).rejects.toThrow(/audit log unavailable/)
    expect(auditFailure.sendMessage).not.toHaveBeenCalled()
    expect(auditFailure.state.completeReply).not.toHaveBeenCalled()
  })

  it('markiert einen fehlgeschlagenen Send nie als tatsaechlich gesendet', async () => {
    const failed = setup({ autoSendEnabled: true, answer: SAFE_ANSWER })
    failed.sendMessage.mockRejectedValueOnce(new Error('chatwoot timeout'))

    await expect(
      failed.processor.process({ tenant: tenants[0]!, payload: incomingPayload() }),
    ).rejects.toThrow(/chatwoot timeout/)
    expect(failed.autoSend.record).toHaveBeenCalledOnce()
    expect(failed.autoSend.markSent).not.toHaveBeenCalled()
  })
})
