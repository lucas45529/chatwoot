import { describe, expect, it, vi } from 'vitest'
import { PostgresKnowledgeRepository } from '../src/knowledge/repository.js'
import { MessageProcessor } from '../src/processor.js'
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

function setup(
  hits: unknown[] = [{ sourceId: 'source-1', title: 'Onboarding', content: 'Kontoeinrichtung', metadata: {}, score: 0.4 }],
) {
  const search = vi.fn().mockResolvedValue(hits)
  const answer = vi.fn().mockResolvedValue({
    action: 'answer',
    text: 'Du startest mit der Kontoeinrichtung.',
    sourceIds: ['source-1'],
  })
  const sendMessage = vi.fn().mockResolvedValue(undefined)
  const saveDraft = vi.fn().mockResolvedValue(undefined)
  const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
  const setPriority = vi.fn().mockResolvedValue(undefined)
  const addLabels = vi.fn().mockResolvedValue(undefined)
  const assign = vi.fn().mockResolvedValue(undefined)
  const handoff = vi.fn().mockResolvedValue(undefined)
  const loadContext = vi.fn().mockResolvedValue({
    turns: [],
    labels: [],
    needsIdentityClarification: false,
    hasContactChannel: false,
    humanRepliedAfterBot: false,
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
    knowledge: { search },
    claude: { answer },
    chatwoot: { sendMessage, sendPrivateNote, saveDraft, setPriority, addLabels, assign, handoff },
    context: { loadContext },
    state,
    minRetrievalScore: 0.1,
    maxSources: 4,
  })
  return {
    processor,
    search,
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
  }
}

describe('MessageProcessor', () => {
  it('uses only the configured tenant and hands off unsafe or unsupported questions', async () => {
    const supported = setup()
    await supported.processor.process({ tenant: tenants[1]!, payload: incomingPayload({ account: { id: 202 } }) })
    expect(supported.search).toHaveBeenCalledWith('new_academy', expect.any(String), 4, 0.1)
    expect(supported.answer).toHaveBeenCalledWith(expect.objectContaining({ tenantKey: 'new_academy' }))
    expect(supported.saveDraft).toHaveBeenCalledOnce()
    expect(supported.sendMessage).not.toHaveBeenCalled()

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

    const unsupported = setup([])
    await unsupported.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(unsupported.answer).not.toHaveBeenCalled()
    expect(unsupported.handoff).toHaveBeenCalledOnce()
  })

  it('answers a presence check naturally without retrieval or human handoff', async () => {
    const presence = setup([])
    await presence.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Ist jemand hier ?' }),
    })

    expect(presence.search).not.toHaveBeenCalled()
    expect(presence.answer).not.toHaveBeenCalled()
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

  it('resumes after a human reply and drafts a context-grounded clarification', async () => {
    const thread = setup()
    thread.state.isHandedOff.mockResolvedValueOnce(true)
    thread.loadContext.mockResolvedValueOnce({
      turns: [
        { role: 'assistant', text: 'Danke für deine Nachricht. Ein Kollege meldet sich.' },
        { role: 'human', text: 'Hallo, wie können wir helfen?' },
        {
          role: 'customer',
          text: 'Ich habe die Änderung der Bank bestätigt. Mir wurden zwei Leads versprochen.',
        },
      ],
      labels: ['ki-uebergabe'],
      needsIdentityClarification: true,
      hasContactChannel: true,
      humanRepliedAfterBot: true,
    })
    thread.answer.mockResolvedValueOnce({
      action: 'clarify',
      text:
        'Klar, ich schaue mir das an. Wie heißt du und mit welcher E-Mail-Adresse bist du registriert?',
      sourceIds: [],
    })

    await thread.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Die möchte ich gerne haben :)' }),
    })

    expect(thread.state.activateConversation).toHaveBeenCalledWith('saas', 77)
    expect(thread.search).not.toHaveBeenCalled()
    expect(thread.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Die möchte ich gerne haben :)',
        sources: [],
        conversationContext: expect.objectContaining({
          needsIdentityClarification: true,
          humanRepliedAfterBot: true,
        }),
      }),
    )
    expect(thread.saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      'Klar, ich schaue mir das an. Wie heißt du und mit welcher E-Mail-Adresse bist du registriert?',
    )
    expect(thread.sendMessage).not.toHaveBeenCalled()
    expect(thread.addLabels).toHaveBeenCalledWith(tenants[0], 77, ['ki-entwurf'])
    expect(thread.assign).toHaveBeenCalledWith(tenants[0], 77, tenants[0]!.handoffAssigneeId)
    expect(thread.handoff).toHaveBeenCalledOnce()
    expect(thread.state.completeHandoff).toHaveBeenCalledWith('saas', 55, 77)
  })

  it('starts a new topic after the latest human reply instead of reusing stale identity context', async () => {
    const newTopic = setup()
    newTopic.loadContext.mockResolvedValueOnce({
      turns: [
        { role: 'customer', text: 'Mir wurden zwei Leads versprochen.' },
        {
          role: 'human',
          text: 'Wie heißt du und mit welcher E-Mail-Adresse bist du registriert?',
        },
      ],
      labels: ['ki-entwurf'],
      needsIdentityClarification: true,
      hasContactChannel: true,
      humanRepliedAfterBot: true,
    })

    await newTopic.processor.process({
      tenant: tenants[0]!,
      payload: incomingPayload({ content: 'Wie erstelle ich meinen ersten Kontakt?' }),
    })

    expect(newTopic.search).toHaveBeenCalled()
    expect(newTopic.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Wie erstelle ich meinen ersten Kontakt?',
        sources: expect.arrayContaining([expect.objectContaining({ sourceId: 'source-1' })]),
      }),
    )
    expect(newTopic.saveDraft).toHaveBeenCalled()
  })

  it('keeps sensitive and explicit-human handoffs under human control', async () => {
    for (const label of ['zahlung', 'mensch-gewuenscht']) {
      const blocked = setup([])
      blocked.state.isHandedOff.mockResolvedValueOnce(true)
      blocked.loadContext.mockResolvedValueOnce({
        turns: [{ role: 'human', text: 'Ich übernehme den Fall.' }],
        labels: ['ki-uebergabe', label],
        needsIdentityClarification: false,
        hasContactChannel: true,
        humanRepliedAfterBot: true,
      })
      await blocked.processor.process({
        tenant: tenants[0]!,
        payload: incomingPayload({ content: 'Gibt es schon etwas Neues?' }),
      })
      expect(blocked.state.activateConversation).not.toHaveBeenCalled()
      expect(blocked.answer).not.toHaveBeenCalled()
      expect(blocked.saveDraft).not.toHaveBeenCalled()
      expect(blocked.sendMessage).not.toHaveBeenCalled()
    }
  })

  it('suppresses terminal and concurrently owned deliveries without side effects', async () => {
    const handedOff = setup()
    handedOff.state.isHandedOff.mockResolvedValueOnce(true)
    await handedOff.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(handedOff.answer).not.toHaveBeenCalled()
    expect(handedOff.sendMessage).not.toHaveBeenCalled()

    for (const status of ['replied', 'handed_off', 'processing', 'sending'] as const) {
      const duplicate = setup()
      duplicate.state.beginDelivery.mockResolvedValueOnce({ status, acquired: false })
      await duplicate.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
      expect(duplicate.sendMessage).not.toHaveBeenCalled()
      expect(duplicate.setPriority).not.toHaveBeenCalled()
      expect(duplicate.handoff).not.toHaveBeenCalled()
      expect(duplicate.state.completeHandoff).not.toHaveBeenCalled()
    }
  })

  it('keeps sources internal and puts the answer into the human composer', async () => {
    const selected = setup([
      { sourceId: 'source-1', title: 'Quelle Eins', content: 'A', metadata: {}, score: 0.4 },
      { sourceId: 'source-2', title: 'Quelle Zwei', content: 'B', metadata: {}, score: 0.3 },
    ])
    selected.answer.mockResolvedValueOnce({ action: 'answer', text: 'Antwort', sourceIds: ['source-2'] })
    await selected.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(selected.saveDraft).toHaveBeenCalledWith(tenants[0], 77, 'Antwort')
    expect(selected.sendMessage).not.toHaveBeenCalled()
    expect(selected.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Quelle Zwei [source-2]'),
      55,
      'draft_note',
    )
    expect(selected.sendPrivateNote.mock.calls[0]![2]).not.toContain('Quelle Eins')
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
    expect(ledgerFailure.saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      'Du startest mit der Kontoeinrichtung.',
    )
    expect(ledgerFailure.sendMessage).not.toHaveBeenCalled()
    expect(ledgerFailure.setPriority).not.toHaveBeenCalled()
  })
})
