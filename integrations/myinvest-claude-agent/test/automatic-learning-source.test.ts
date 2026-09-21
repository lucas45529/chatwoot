import { describe, expect, it, vi } from 'vitest'
import { buildTenantRegistry } from '../src/config.js'
import {
  automaticLearningCursorSchema,
  automaticLearningSourceIdsSchema,
  discoverAutomaticLearningSources,
  resolveAutomaticLearningSource,
} from '../src/learning/automatic-source.js'
import { tenants } from './fixtures.js'

const registry = buildTenantRegistry(
  tenants.map((tenant, index) => ({ ...tenant, agentBotId: 801 + index })),
)

const source = {
  accountId: 101,
  inboxId: 17,
  conversationId: 77,
  questionMessageId: 55,
  draftMessageId: 61,
  answerMessageId: 62,
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    account_id: '101',
    inbox_id: '17',
    conversation_display_id: '77',
    conversation_internal_id: '700',
    question_message_id: '55',
    draft_message_id: '61',
    answer_message_id: '62',
    question: 'Wie bearbeite ich den Kontakt kunde@example.test?',
    draft_note:
      'KI-Entwurf\n\nAntwortvorschlag:\nÖffne Kontakte und wähle Bearbeiten.\nQuellen: Hilfe',
    corrected_answer:
      'Öffne Kontakte, wähle den Eintrag und nutze anschließend die Aktion Bearbeiten.',
    question_created_at: '2026-09-20T10:00:00.000Z',
    draft_created_at: '2026-09-20T10:01:00.000Z',
    answer_created_at: '2026-09-20T10:02:00.000Z',
    answer_status: 1,
    conversation_tenant: null,
    conversation_channel: null,
    source_tenant: null,
    default_tenant: 'saas',
    history: [
      {
        id: '50',
        created_at: '2026-09-20T09:59:00.000Z',
        message_type: 1,
        sender_type: 'User',
        content: 'Schreibe an alpha@example.test.',
        from_automation: false,
        from_campaign: false,
        external_echo: false,
      },
    ],
    ...overrides,
  }
}

describe('automatic human-correction provenance', () => {
  it('discovers one bounded, redacted source and exposes only display/source IDs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] })
    const result = await discoverAutomaticLearningSources(
      { query },
      registry,
      { limit: 10, now: new Date('2026-09-21T10:00:00.000Z') },
    )

    expect(result.nextCursor).toBeUndefined()
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({
      tenant: 'saas',
      channel: 'web',
      source,
      question: 'Wie bearbeite ich den Kontakt [E-MAIL/ACCOUNT]',
      previousDraft: 'Öffne Kontakte und wähle Bearbeiten.',
      correctedAnswer:
        'Öffne Kontakte, wähle den Eintrag und nutze anschließend die Aktion Bearbeiten.',
      history: [{ role: 'agent', text: 'Schreibe an [E-MAIL/ACCOUNT]' }],
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(JSON.stringify(result)).not.toContain('@example.test')

    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]]
    for (const clause of [
      "question.sender_type = 'Contact'",
      'question.sender_id = conversation.contact_id',
      "draft.sender_type = 'AgentBot'",
      'draft.sender_id = configured.agent_bot_id',
      "answer.sender_type = 'User'",
      'answer.status IN (0, 1, 2)',
      "answer.status IN (1, 2)",
      "nullif(answer.source_id, '') IS NOT NULL",
      "conversation.custom_attributes ->> 'myinvest_channel', 'web') = 'web'",
      "draft_attrs.value ->> 'myinvest_agent_delivery_id' = question.id::text",
      "myinvest_agent_message_kind' IN ('draft_note', 'clarify_draft_note', 'handoff_note')",
      "myinvest_agent_action', '') <> 'preprocessed'",
      "answer.source_id, '') NOT LIKE 'mip:%'",
      "additional_attributes ? 'campaign_id'",
      "myinvest_agent_message_kind' = 'document_assistance_note'",
      'newer_question.created_at, newer_question.id',
      'newer_draft.created_at, newer_draft.id',
      'LIMIT 12',
    ]) {
      expect(sql).toContain(clause)
    }
    expect(values).toContain('2026-09-07T10:00:00.000Z')
    expect(values).toContain('2026-09-21T10:00:00.000Z')
  })

  it('uses a strict descending keyset cursor and never scans without a bound', async () => {
    const answerTime = '2026-09-20T10:02:00.000Z'
    const rows = Array.from({ length: 6 }, (_, index) =>
      row({
        answer_message_id: String(62 - index),
        answer_created_at: answerTime,
        corrected_answer: `Öffne Kontakte und nutze die geprüfte Aktion ${index}.`,
      }),
    )
    const query = vi.fn().mockResolvedValue({ rows })
    const result = await discoverAutomaticLearningSources(
      { query },
      registry,
      {
        limit: 1,
        cursor: { answeredAt: answerTime, answerMessageId: 70 },
        now: new Date('2026-09-21T10:00:00.000Z'),
      },
    )

    expect(result.sources).toHaveLength(1)
    expect(result.nextCursor).toEqual({
      answeredAt: answerTime,
      answerMessageId: 62,
    })
    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]]
    expect(sql).toContain('(answer.created_at, answer.id) <')
    expect(sql).toContain('LIMIT $9')
    expect(values[8]).toBe(6)
    expect(values[9]).toBeNull()
  })

  it('bounds discovery to one resolved tenant before pagination', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        row({
          conversation_tenant: 'new_academy',
          conversation_channel: 'whatsapp',
          source_tenant: 'new_academy',
        }),
      ],
    })
    const result = await discoverAutomaticLearningSources(
      { query },
      registry,
      {
        tenant: 'new_academy',
        now: new Date('2026-09-21T10:00:00.000Z'),
      },
    )

    expect(result.sources[0]).toMatchObject({
      tenant: 'new_academy',
      channel: 'whatsapp',
    })
    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]]
    expect(sql).toContain("question_attrs.value ->> 'myinvest_tenant'")
    expect(values[9]).toBe('new_academy')
  })

  it.each([
    ['unchanged draft', { corrected_answer: 'Öffne Kontakte und wähle Bearbeiten.' }],
    ['sensitive topic', { corrected_answer: 'Bitte kündige den Vertrag schriftlich beim Support.' }],
    ['non-reusable text', { corrected_answer: 'Wie heißt du und wie können wir helfen?' }],
    ['residual secret', { corrected_answer: 'Nutze access_token-abcdefghijklmnop für diesen Vorgang.' }],
    ['missing draft', { draft_note: 'Vorschlag zur Referenz:\nKein eigener Entwurf.' }],
  ])('drops %s before returning reusable text', async (_label, override) => {
    const query = vi.fn().mockResolvedValue({ rows: [row(override)] })
    await expect(
      discoverAutomaticLearningSources(
        { query },
        registry,
        { now: new Date('2026-09-21T10:00:00.000Z') },
      ),
    ).resolves.toEqual({ sources: [] })
  })

  it('re-resolves exact source IDs and rejects content drift by hash', async () => {
    const discoverQuery = vi.fn().mockResolvedValue({ rows: [row()] })
    const discovered = await discoverAutomaticLearningSources(
      { query: discoverQuery },
      registry,
      { now: new Date('2026-09-21T10:00:00.000Z') },
    )
    const original = discovered.sources[0]!
    const resolveQuery = vi.fn().mockResolvedValue({ rows: [row()] })
    await expect(
      resolveAutomaticLearningSource(
        { query: resolveQuery },
        registry,
        { source, contentHash: original.contentHash },
      ),
    ).resolves.toEqual(original)
    expect(resolveQuery.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([101, 17, 77, 55, 61, 62]),
    )

    const drifted = vi.fn().mockResolvedValue({
      rows: [row({ corrected_answer: 'Eine nachträglich geänderte Antwort.' })],
    })
    await expect(
      resolveAutomaticLearningSource(
        { query: drifted },
        registry,
        { source, contentHash: original.contentHash },
      ),
    ).rejects.toThrow('automatic_learning_source_changed')
  })

  it('keeps the source hash stable across normal delivery status transitions', async () => {
    const queued = vi.fn().mockResolvedValue({
      rows: [row({ answer_status: 0 })],
    })
    const delivered = vi.fn().mockResolvedValue({
      rows: [row({ answer_status: 2 })],
    })

    const queuedSource = (
      await discoverAutomaticLearningSources({ query: queued }, registry, {
        now: new Date('2026-09-21T10:00:00.000Z'),
      })
    ).sources[0]!
    const deliveredSource = (
      await discoverAutomaticLearningSources({ query: delivered }, registry, {
        now: new Date('2026-09-21T10:00:00.000Z'),
      })
    ).sources[0]!

    expect(deliveredSource.contentHash).toBe(queuedSource.contentHash)
  })

  it.each([
    [
      'mutation',
      [
        {
          id: '50',
          created_at: '2026-09-20T09:59:00.000Z',
          message_type: 1,
          sender_type: 'User',
          content: 'Ein nachträglich geänderter Verlauf.',
          from_automation: false,
          from_campaign: false,
          external_echo: false,
        },
      ],
    ],
    ['deletion', []],
  ])('rejects prior history %s during source re-resolution', async (_label, history) => {
    const discoverQuery = vi.fn().mockResolvedValue({ rows: [row()] })
    const original = (
      await discoverAutomaticLearningSources({ query: discoverQuery }, registry, {
        now: new Date('2026-09-21T10:00:00.000Z'),
      })
    ).sources[0]!
    const resolveQuery = vi.fn().mockResolvedValue({
      rows: [row({ history })],
    })

    await expect(
      resolveAutomaticLearningSource({ query: resolveQuery }, registry, {
        source: original.source,
        contentHash: original.contentHash,
      }),
    ).rejects.toThrow('automatic_learning_source_changed')
  })

  it('rejects unknown tenants, missing bot identity and malformed source envelopes before SQL', async () => {
    const query = vi.fn()
    await expect(
      resolveAutomaticLearningSource(
        { query },
        registry,
        {
          source: { ...source, accountId: 999 },
          contentHash: 'a'.repeat(64),
        },
      ),
    ).rejects.toThrow('automatic_learning_source_not_found')
    await expect(
      resolveAutomaticLearningSource(
        { query },
        buildTenantRegistry(tenants),
        { source, contentHash: 'a'.repeat(64) },
      ),
    ).rejects.toThrow('automatic_learning_source_identity_unavailable')
    expect(query).not.toHaveBeenCalled()
    expect(
      automaticLearningSourceIdsSchema.safeParse({ ...source, extra: 'text' })
        .success,
    ).toBe(false)
    expect(
      automaticLearningCursorSchema.safeParse({
        answeredAt: 'not-a-date',
        answerMessageId: 1,
      }).success,
    ).toBe(false)
  })
})
