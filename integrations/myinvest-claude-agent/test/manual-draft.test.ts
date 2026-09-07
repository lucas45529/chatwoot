import { describe, expect, it, vi } from 'vitest'
import { buildTenantRegistry } from '../src/config.js'
import { supportBrainRequestId } from '../src/auto-send.js'
import {
  ManualDraftService,
  manualReviewRequestId,
  manualDraftRequestSchema,
  proposalSchema,
  type ManualDraftDependencies,
} from '../src/manual-draft.js'
import { PSEUDONYMIZATION_KEY, tenants } from './fixtures.js'

const sourceRow = {
  conversation_id: '9001',
  inbox_id: 17,
  source_message_id: '243',
  source_content: 'Wie richte ich mein Konto ein?',
  source_content_type: 0,
  source_has_attachment: false,
  human_replied_after_inbound: false,
  draft_note_exists: false,
}

function dependencies(overrides: Partial<ManualDraftDependencies> = {}) {
  const database = {
    query: vi.fn().mockResolvedValue({ rows: [sourceRow] }),
  }
  const context = {
    loadContext: vi.fn().mockResolvedValue({
      turns: [
        { role: 'customer' as const, text: 'Frühere Frage' },
        { role: 'human' as const, text: 'Frühere Antwort' },
      ],
      labels: [],
      humanRepliedAfterBot: false,
      humanEverReplied: true,
    }),
  }
  const brain = {
    answer: vi.fn().mockResolvedValue({
      action: 'answer' as const,
      text: 'Öffnen Sie zuerst die Einstellungen.',
      confidence: 0.8,
      sources: [{ title: 'Hilfe', url: 'https://example.test/hilfe' }],
      safeToAutoSend: true,
    }),
  }
  const drafts = {
    loadDraft: vi.fn().mockResolvedValue(undefined),
  }
  const proposals = {
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  }
  const chatwoot = {
    saveDraft: vi.fn().mockResolvedValue({
      written: true,
      message: 'Öffnen Sie zuerst die Einstellungen.',
    }),
    sendPrivateNote: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
  return {
    values: {
      database,
      context,
      brain,
      drafts,
      proposals,
      chatwoot,
      tenants: buildTenantRegistry(tenants),
      pseudonymizationKey: PSEUDONYMIZATION_KEY,
      whatsappInboxIds: new Set<number>(),
      ...overrides,
    } satisfies ManualDraftDependencies,
    database,
    context,
    brain,
    drafts,
    proposals,
    chatwoot,
  }
}

describe('ManualDraftService', () => {
  it('creates only an editable internal draft from the redacted context', async () => {
    const fixture = dependencies()
    const service = new ManualDraftService(fixture.values)

    await expect(service.createDraft({ accountId: 101, conversationId: 77 }))
      .resolves.toEqual({ status: 'ready' })

    expect(fixture.database.query).toHaveBeenCalledWith(
      expect.stringContaining('conversation.account_id = $1'),
      [101, 77, 17],
    )
    expect(fixture.context.loadContext).toHaveBeenCalledWith({
      accountId: 101,
      conversationDisplayId: 77,
      currentMessageId: 243,
    })
    expect(fixture.brain.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Wie richte ich mein Konto ein?',
        history: [
          { role: 'user', text: 'Frühere Frage' },
          { role: 'agent', text: 'Frühere Antwort' },
        ],
        tenant: 'saas',
        channel: 'web',
        reviewOnly: true,
      }),
      undefined,
    )
    expect(fixture.chatwoot.saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      'Öffnen Sie zuerst die Einstellungen.',
    )
    expect(fixture.chatwoot.sendPrivateNote).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringContaining('Antwortvorschlag:\nÖffnen Sie zuerst die Einstellungen.'),
      243,
      'draft_note',
    )
    expect(fixture.chatwoot.sendMessage).not.toHaveBeenCalled()
    expect(fixture.proposals.save).toHaveBeenCalledWith(
      'manual-draft:v1:saas:101:77',
      expect.objectContaining({
        sourceMessageId: 243,
        draft: 'Öffnen Sie zuerst die Einstellungen.',
        note: expect.stringContaining('Antwortvorschlag:'),
      }),
    )
    expect(fixture.proposals.save.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.chatwoot.saveDraft.mock.invocationCallOrder[0]!,
    )
    expect(fixture.proposals.clear).toHaveBeenCalledWith(
      'manual-draft:v1:saas:101:77',
    )
  })

  it('returns the existing source-linked draft without asking the brain again', async () => {
    const fixture = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{ ...sourceRow, draft_note_exists: true }],
      }) },
      drafts: { loadDraft: vi.fn().mockResolvedValue('Bestehender KI-Entwurf') },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'existing' })
    expect(fixture.brain.answer).not.toHaveBeenCalled()
    expect(fixture.chatwoot.saveDraft).not.toHaveBeenCalled()
    expect(fixture.chatwoot.sendPrivateNote).not.toHaveBeenCalled()
  })

  it('preserves a nonempty human draft without generating', async () => {
    const fixture = dependencies({
      drafts: { loadDraft: vi.fn().mockResolvedValue('Menschlicher Entwurf') },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'preserved' })
    expect(fixture.brain.answer).not.toHaveBeenCalled()
    expect(fixture.chatwoot.saveDraft).not.toHaveBeenCalled()
  })

  it('does not draft after a newer public human response', async () => {
    const fixture = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{ ...sourceRow, human_replied_after_inbound: true }],
      }) },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'already_answered' })
    expect(fixture.drafts.loadDraft).toHaveBeenCalledOnce()
    expect(fixture.proposals.load).toHaveBeenCalledOnce()
    expect(fixture.brain.answer).not.toHaveBeenCalled()
  })

  it('uses a clarification draft for an attachment placeholder without calling the brain', async () => {
    const saveDraft = vi.fn().mockResolvedValue({ written: true, message: 'fallback' })
    const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
    const fixture = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{
          ...sourceRow,
          source_content: '(audio-Nachricht ohne Text)',
          source_content_type: 1,
          source_has_attachment: true,
        }],
      }) },
      chatwoot: {
        saveDraft,
        sendPrivateNote,
      },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'ready' })
    expect(fixture.brain.answer).not.toHaveBeenCalled()
    expect(saveDraft).toHaveBeenCalledWith(
      tenants[0],
      77,
      expect.stringMatching(/Anhang/),
    )
    expect(sendPrivateNote).toHaveBeenCalledWith(
      tenants[0], 77, expect.any(String), 243, 'draft_note',
    )
  })

  it('returns unavailable for unknown accounts, cross-account conversations, and unsupported inboxes', async () => {
    const unknown = dependencies()
    await expect(new ManualDraftService(unknown.values).createDraft({
      accountId: 999,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })
    expect(unknown.database.query).not.toHaveBeenCalled()

    const missing = dependencies({
      database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
    })
    await expect(new ManualDraftService(missing.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })

    const wrongInbox = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{ ...sourceRow, inbox_id: 999 }],
      }) },
    })
    await expect(new ManualDraftService(wrongInbox.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })
    expect(wrongInbox.brain.answer).not.toHaveBeenCalled()
  })

  it('reports a concurrent composer edit as preserved and does not attach false provenance', async () => {
    const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
    const fixture = dependencies({
      chatwoot: {
        saveDraft: vi.fn().mockResolvedValue({ written: false, message: 'Neue menschliche Eingabe' }),
        sendPrivateNote,
      },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'preserved' })
    expect(sendPrivateNote).not.toHaveBeenCalled()
  })

  it('discards a generated answer when a newer inbound message arrives during generation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({
        rows: [{ ...sourceRow, source_message_id: '244', source_content: 'Neue Frage' }],
      })
    const fixture = dependencies({ database: { query } })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })
    expect(fixture.brain.answer).toHaveBeenCalledOnce()
    expect(fixture.chatwoot.saveDraft).not.toHaveBeenCalled()
    expect(fixture.chatwoot.sendPrivateNote).not.toHaveBeenCalled()
  })

  it('discards a generated answer when a human replies during generation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({
        rows: [{ ...sourceRow, human_replied_after_inbound: true }],
      })
    const fixture = dependencies({ database: { query } })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'already_answered' })
    expect(fixture.chatwoot.saveDraft).not.toHaveBeenCalled()
  })

  it('repairs a private-note partial write from the exact pending draft without using the brain', async () => {
    const proposal = {
      sourceMessageId: 243,
      draft: 'Bereits geschriebener KI-Entwurf',
      note: 'Exakte gespeicherte Provenienznotiz',
    }
    const clear = vi.fn().mockResolvedValue(undefined)
    const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
    const fixture = dependencies({
      drafts: { loadDraft: vi.fn().mockResolvedValue(proposal.draft) },
      proposals: {
        load: vi.fn().mockResolvedValue(proposal),
        save: vi.fn(),
        clear,
      },
      chatwoot: {
        saveDraft: vi.fn(),
        sendPrivateNote,
      },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'existing' })
    expect(fixture.brain.answer).not.toHaveBeenCalled()
    expect(sendPrivateNote).toHaveBeenCalledWith(
      tenants[0], 77, proposal.note, 243, 'draft_note',
    )
    expect(clear).toHaveBeenCalledWith('manual-draft:v1:saas:101:77')
  })

  it('preserves a human edit that differs from a pending proposal', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const saveDraft = vi.fn()
    const sendPrivateNote = vi.fn()
    const fixture = dependencies({
      drafts: { loadDraft: vi.fn().mockResolvedValue('Menschlich geändert') },
      proposals: {
        load: vi.fn().mockResolvedValue({
          sourceMessageId: 243,
          draft: 'KI-Text',
          note: 'KI-Notiz',
        }),
        save: vi.fn(),
        clear,
      },
      chatwoot: { saveDraft, sendPrivateNote },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'preserved' })
    expect(fixture.brain.answer).not.toHaveBeenCalled()
    expect(saveDraft).not.toHaveBeenCalled()
    expect(sendPrivateNote).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('finds an older pending proposal after source drift and compensates even after abort', async () => {
    const controller = new AbortController()
    const proposal = {
      sourceMessageId: 243,
      draft: 'Alter KI-Entwurf',
      note: 'Alte Notiz',
    }
    const clear = vi.fn().mockResolvedValue(undefined)
    const saveDraft = vi.fn().mockResolvedValue({ written: true, message: '' })
    const fixture = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{ ...sourceRow, source_message_id: '244', source_content: 'Neue Frage' }],
      }) },
      drafts: { loadDraft: vi.fn().mockResolvedValue(proposal.draft) },
      proposals: {
        load: vi.fn().mockImplementation(async () => {
          controller.abort()
          return proposal
        }),
        save: vi.fn(),
        clear,
      },
      chatwoot: { saveDraft, sendPrivateNote: vi.fn() },
    })

    await expect(new ManualDraftService(fixture.values).createDraft(
      { accountId: 101, conversationId: 77 },
      controller.signal,
    )).resolves.toEqual({ status: 'unavailable' })
    expect(saveDraft).toHaveBeenCalledWith(
      tenants[0], 77, '', proposal.draft,
    )
    expect(clear).toHaveBeenCalledWith('manual-draft:v1:saas:101:77')
    expect(fixture.brain.answer).not.toHaveBeenCalled()
  })

  it('loads and rolls back pending work before returning already answered', async () => {
    const proposal = {
      sourceMessageId: 243,
      draft: 'Zu spät geschriebener KI-Entwurf',
      note: 'Nicht mehr benötigte Notiz',
    }
    const saveDraft = vi.fn().mockResolvedValue({ written: true, message: '' })
    const clear = vi.fn().mockResolvedValue(undefined)
    const fixture = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{ ...sourceRow, human_replied_after_inbound: true }],
      }) },
      drafts: { loadDraft: vi.fn().mockResolvedValue(proposal.draft) },
      proposals: {
        load: vi.fn().mockResolvedValue(proposal),
        save: vi.fn(),
        clear,
      },
      chatwoot: { saveDraft, sendPrivateNote: vi.fn() },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'already_answered' })
    expect(saveDraft).toHaveBeenCalledWith(
      tenants[0], 77, '', proposal.draft,
    )
    expect(clear).toHaveBeenCalledOnce()
  })

  it('retains stale pending recovery when rollback preserves a human draft', async () => {
    const proposal = {
      sourceMessageId: 243,
      draft: 'Alter KI-Entwurf',
      note: 'Alte Notiz',
    }
    const clear = vi.fn()
    const saveDraft = vi.fn().mockResolvedValue({
      written: false,
      message: 'Menschliche Antwort',
    })
    const fixture = dependencies({
      database: { query: vi.fn().mockResolvedValue({
        rows: [{ ...sourceRow, source_message_id: '244', source_content: 'Neue Frage' }],
      }) },
      drafts: { loadDraft: vi.fn().mockResolvedValue('Menschliche Antwort') },
      proposals: {
        load: vi.fn().mockResolvedValue(proposal),
        save: vi.fn(),
        clear,
      },
      chatwoot: { saveDraft, sendPrivateNote: vi.fn() },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })
    expect(saveDraft).toHaveBeenCalledWith(
      tenants[0], 77, '', proposal.draft,
    )
    expect(clear).not.toHaveBeenCalled()
  })

  it('keeps a pending proposal when its private note fails so a retry can repair it', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const fixture = dependencies({
      proposals: {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
        clear,
      },
      chatwoot: {
        saveDraft: vi.fn().mockResolvedValue({ written: true, message: 'KI-Text' }),
        sendPrivateNote: vi.fn().mockRejectedValue(new Error('temporary note failure')),
      },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('rolls back its exact draft when the source changes after the CAS write', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({
        rows: [{ ...sourceRow, source_message_id: '244', source_content: 'Neue Frage' }],
      })
    const saveDraft = vi.fn()
      .mockResolvedValueOnce({ written: true, message: 'Öffnen Sie zuerst die Einstellungen.' })
      .mockResolvedValueOnce({ written: true, message: '' })
    const sendPrivateNote = vi.fn()
    const clear = vi.fn().mockResolvedValue(undefined)
    const fixture = dependencies({
      database: { query },
      proposals: {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
        clear,
      },
      chatwoot: { saveDraft, sendPrivateNote },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'unavailable' })
    expect(saveDraft).toHaveBeenNthCalledWith(
      2,
      tenants[0],
      77,
      '',
      'Öffnen Sie zuerst die Einstellungen.',
    )
    expect(sendPrivateNote).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('rolls back its exact draft when a human replies after the CAS write', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({ rows: [sourceRow] })
      .mockResolvedValueOnce({
        rows: [{ ...sourceRow, human_replied_after_inbound: true }],
      })
    const saveDraft = vi.fn()
      .mockResolvedValueOnce({ written: true, message: 'Öffnen Sie zuerst die Einstellungen.' })
      .mockResolvedValueOnce({ written: true, message: '' })
    const sendPrivateNote = vi.fn()
    const fixture = dependencies({
      database: { query },
      chatwoot: { saveDraft, sendPrivateNote },
    })

    await expect(new ManualDraftService(fixture.values).createDraft({
      accountId: 101,
      conversationId: 77,
    })).resolves.toEqual({ status: 'already_answered' })
    expect(saveDraft).toHaveBeenNthCalledWith(
      2,
      tenants[0],
      77,
      '',
      'Öffnen Sie zuerst die Einstellungen.',
    )
    expect(sendPrivateNote).not.toHaveBeenCalled()
  })

  it('passes cancellation to the brain and performs no later side effect', async () => {
    const controller = new AbortController()
    const brain = {
      answer: vi.fn().mockImplementation(async () => {
        controller.abort()
        return {
          action: 'answer' as const,
          text: 'Zu spät',
          confidence: 0.8,
          sources: [],
          safeToAutoSend: false,
        }
      }),
    }
    const fixture = dependencies({ brain })

    await expect(new ManualDraftService(fixture.values).createDraft(
      { accountId: 101, conversationId: 77 },
      controller.signal,
    )).resolves.toEqual({ status: 'unavailable' })
    expect(brain.answer).toHaveBeenCalledWith(
      expect.objectContaining({ reviewOnly: true }),
      controller.signal,
    )
    expect(fixture.proposals.save).not.toHaveBeenCalled()
    expect(fixture.chatwoot.saveDraft).not.toHaveBeenCalled()
  })

  it('uses a stable manual-review replay ID distinct from automatic processing', () => {
    const manual = manualReviewRequestId(PSEUDONYMIZATION_KEY, 101, 243)
    expect(manual).toMatch(/^[0-9a-f-]{36}$/)
    expect(manualReviewRequestId(PSEUDONYMIZATION_KEY, 101, 243)).toBe(manual)
    expect(manual).not.toBe(supportBrainRequestId(PSEUDONYMIZATION_KEY, 101, 243))
    expect(proposalSchema.safeParse({ sourceMessageId: 243, draft: 'Text', note: 'Notiz' }).success).toBe(true)
    expect(proposalSchema.safeParse({ sourceMessageId: 243, draft: 'Text', note: 'Notiz', extra: true }).success).toBe(false)
  })

  it('exposes a strict request contract and never returns customer text', () => {
    expect(manualDraftRequestSchema.safeParse({
      action: 'draft', accountId: 101, conversationId: 77,
    }).success).toBe(true)
    expect(manualDraftRequestSchema.safeParse({
      action: 'draft', accountId: 101, conversationId: 77, extra: true,
    }).success).toBe(false)
  })
})
