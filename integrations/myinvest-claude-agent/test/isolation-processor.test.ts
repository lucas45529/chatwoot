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
    text: 'Du startest mit der Kontoeinrichtung.',
    sourceIds: ['source-1'],
  })
  const sendMessage = vi.fn().mockResolvedValue(undefined)
  const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
  const setPriority = vi.fn().mockResolvedValue(undefined)
  const addLabels = vi.fn().mockResolvedValue(undefined)
  const assign = vi.fn().mockResolvedValue(undefined)
  const handoff = vi.fn().mockResolvedValue(undefined)
  const state = {
    isHandedOff: vi.fn().mockResolvedValue(false),
    beginDelivery: vi.fn().mockResolvedValue({ status: 'processing', acquired: true }),
    markSending: vi.fn().mockResolvedValue(undefined),
    completeReply: vi.fn().mockResolvedValue(undefined),
    completeHandoff: vi.fn().mockResolvedValue(undefined),
    failDelivery: vi.fn().mockResolvedValue(undefined),
  }
  const processor = new MessageProcessor({
    knowledge: { search },
    claude: { answer },
    chatwoot: { sendMessage, sendPrivateNote, setPriority, addLabels, assign, handoff },
    state,
    minRetrievalScore: 0.1,
    maxSources: 4,
  })
  return {
    processor,
    search,
    answer,
    sendMessage,
    sendPrivateNote,
    setPriority,
    addLabels,
    assign,
    handoff,
    state,
  }
}

describe('MessageProcessor', () => {
  it('uses only the configured tenant and hands off unsafe or unsupported questions', async () => {
    const supported = setup()
    await supported.processor.process({ tenant: tenants[1]!, payload: incomingPayload({ account: { id: 202 } }) })
    expect(supported.search).toHaveBeenCalledWith('new_academy', expect.any(String), 4, 0.1)
    expect(supported.answer).toHaveBeenCalledWith(expect.objectContaining({ tenantKey: 'new_academy' }))
    expect(supported.sendMessage).toHaveBeenCalledOnce()

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

  it('keeps source references internal and out of the customer reply', async () => {
    const selected = setup([
      { sourceId: 'source-1', title: 'Quelle Eins', content: 'A', metadata: {}, score: 0.4 },
      { sourceId: 'source-2', title: 'Quelle Zwei', content: 'B', metadata: {}, score: 0.3 },
    ])
    selected.answer.mockResolvedValueOnce({ text: 'Antwort', sourceIds: ['source-2'] })
    await selected.processor.process({ tenant: tenants[0]!, payload: incomingPayload() })
    expect(selected.sendMessage).toHaveBeenCalledWith(tenants[0], 77, 'Antwort', 55, 'answer')
    expect(selected.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Quelle Zwei [source-2]'),
      55,
      'answer_sources',
    )
    expect(selected.sendPrivateNote.mock.calls[0]![2]).not.toContain('Quelle Eins')
    expect(selected.state.completeReply).toHaveBeenCalledWith('saas', 55)
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

  it('does not convert a delivered answer into a contradictory handoff when the ledger fails', async () => {
    const ledgerFailure = setup()
    ledgerFailure.state.completeReply.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(
      ledgerFailure.processor.process({ tenant: tenants[0]!, payload: incomingPayload() }),
    ).rejects.toThrow(/database unavailable/)

    expect(ledgerFailure.sendMessage).toHaveBeenCalledTimes(1)
    expect(ledgerFailure.sendMessage).toHaveBeenCalledWith(
      tenants[0],
      77,
      'Du startest mit der Kontoeinrichtung.',
      55,
      'answer',
    )
    expect(ledgerFailure.setPriority).not.toHaveBeenCalled()
    expect(ledgerFailure.handoff).not.toHaveBeenCalled()
    expect(ledgerFailure.state.completeHandoff).not.toHaveBeenCalled()
  })
})
