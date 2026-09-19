import { Client } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ManualDraftService, manualDraftRequestSchema, type ManualDraftProposal } from '../src/manual-draft.js'
import { buildTenantRegistry } from '../src/config.js'
import { tenants, PSEUDONYMIZATION_KEY } from './fixtures.js'
const generationId = '5360ea90-7d1a-4055-9271-1d3b10386a81'
const input = { accountId: 101, conversationId: 77, questionMessageId: 243, draftMessageId: 250, generationId }
const old = 'Der ursprüngliche KI-Entwurf.'
const fresh = 'Die Antwort mit aktuellem Wissen.'
function fixture(withBeta = false) {
  const source = { conversation_id: '9001', inbox_id: 17, source_message_id: '243', source_content: 'Wie richte ich mein Konto ein?', source_content_type: 0, conversation_tenant: null, conversation_channel: null, source_tenant: null, human_replied_after_inbound: false, draft_note_exists: true }
  const notes = { content: `KI-Entwurf\n\nAntwortvorschlag:\n${old}\nQuellen: Hilfe` }
  let current: string | undefined = old
  const stored = new Map<string, ManualDraftProposal>()
  const query = vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.includes('AS regeneration_note') ? [notes] : [source] }))
  const brain = { answer: vi.fn().mockResolvedValue({ action: 'answer', text: fresh, confidence: 0.8, sources: [], safeToAutoSend: false }) }
  const betaBrain = { answer: vi.fn().mockResolvedValue({ action: 'answer', text: 'Beta-Wissen', confidence: 0.8, sources: [], safeToAutoSend: false }) }
  const saveDraft = vi.fn().mockImplementation(async (_tenant, _conversation, text, expected) => {
    if (current !== expected) return { written: false, message: current ?? '' }
    current = text; return { written: true, message: text }
  })
  const sendPrivateNote = vi.fn().mockResolvedValue(undefined)
  const proposals = { load: vi.fn(async (key: string) => stored.get(key)), save: vi.fn(async (key: string, proposal: ManualDraftProposal) => { stored.set(key, structuredClone(proposal)) }), clear: vi.fn(async (key: string) => { stored.delete(key) }) }
  const service = new ManualDraftService({ database: { query }, context: { loadContext: vi.fn().mockResolvedValue({ turns: [], labels: [], humanEverReplied: false, humanRepliedAfterBot: false }) }, brain, ...(withBeta ? { betaBrain } : {}), drafts: { loadDraft: vi.fn(async () => current) }, proposals, chatwoot: { saveDraft, sendPrivateNote }, tenants: buildTenantRegistry(tenants.map(t => ({ ...t, agentBotId: 7 }))), pseudonymizationKey: PSEUDONYMIZATION_KEY, whatsappInboxIds: new Set() })
  return { service, source, notes, query, brain, betaBrain, saveDraft, sendPrivateNote, proposals, stored, edit: (text: string | undefined) => { current = text }, current: () => current }
}
describe('explicit draft preview and apply', () => {
  it('previews current knowledge once per generation without writing drafts or notes', async () => {
    const f = fixture()
    const preview = { status: 'preview', generationId, previousDraft: old, draft: fresh }
    await expect(f.service.previewDraft(input)).resolves.toEqual(preview)
    await expect(f.service.previewDraft(input)).resolves.toEqual(preview)
    expect(f.brain.answer).toHaveBeenCalledOnce()
    expect(f.brain.answer).toHaveBeenCalledWith(expect.objectContaining({ reviewOnly: true }), undefined)
    expect(f.saveDraft).not.toHaveBeenCalled(); expect(f.sendPrivateNote).not.toHaveBeenCalled()
  })
  it('applies only its stored proposal with CAS and generation-bound private provenance', async () => {
    const f = fixture(); await f.service.previewDraft(input)
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'ready' })
    expect(f.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ accountId: 101 }), 77, fresh, old, true)
    expect(f.sendPrivateNote).toHaveBeenCalledWith(expect.anything(), 77, expect.stringContaining(fresh), 243, 'draft_note', { generationId, replacesNoteId: 250 })
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'existing' })
    expect(f.sendPrivateNote).toHaveBeenCalledOnce(); expect(f.brain.answer).toHaveBeenCalledOnce()
  })
  it.each(['Meine Bearbeitung', '', undefined])('preserves human editing or deletion before apply: %s', async text => {
    const f = fixture(); await f.service.previewDraft(input); f.edit(text)
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'preserved' })
    expect(f.saveDraft).not.toHaveBeenCalled(); expect(f.sendPrivateNote).not.toHaveBeenCalled()
  })
  it('preserves edits made during generation and CAS', async () => {
    const f = fixture(); f.brain.answer.mockImplementationOnce(async () => { f.edit('Eigene Antwort'); return { action: 'answer', text: fresh, confidence: 0.8, sources: [], safeToAutoSend: false } })
    await expect(f.service.previewDraft(input)).resolves.toEqual({ status: 'preserved' })
    const other = fixture(); await other.service.previewDraft(input)
    other.saveDraft.mockResolvedValueOnce({ written: false, message: 'Parallel bearbeitet' })
    await expect(other.service.applyDraft(input)).resolves.toEqual({ status: 'preserved' }); expect(other.sendPrivateNote).not.toHaveBeenCalled()
  })
  it('repairs a failed private note without regenerating or replacing again', async () => {
    const f = fixture(); await f.service.previewDraft(input); f.sendPrivateNote.mockRejectedValueOnce(new Error('network'))
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'unavailable' })
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'existing' })
    expect(f.saveDraft).toHaveBeenCalledOnce(); expect(f.brain.answer).toHaveBeenCalledOnce()
  })
  it('does not apply a missing proposal or reuse a generation for another source', async () => {
    const f = fixture(); await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'unavailable' })
    await f.service.previewDraft(input)
    await expect(f.service.applyDraft({ ...input, draftMessageId: 251 })).resolves.toEqual({ status: 'unavailable' })
    expect(f.saveDraft).not.toHaveBeenCalled()
  })
  it.each(['new_question', 'human_reply', 'route', 'forged_note'])('rejects source drift or forged note: %s', async change => {
    const f = fixture(); await f.service.previewDraft(input)
    if (change === 'new_question') f.source.source_message_id = '244'
    if (change === 'human_reply') f.source.human_replied_after_inbound = true
    if (change === 'route') Object.assign(f.source, { conversation_tenant: 'new_academy', conversation_channel: 'web', source_tenant: 'new_academy' })
    if (change === 'forged_note') f.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS regeneration_note') ? [] : [f.source] }))
    expect((await f.service.applyDraft(input)).status).toBe(change === 'human_reply' ? 'already_answered' : 'unavailable')
    expect(f.saveDraft).not.toHaveBeenCalled(); expect(f.sendPrivateNote).not.toHaveBeenCalled()
  })
  it('withdraws only its exact new draft when source changes after CAS', async () => {
    const f = fixture(); await f.service.previewDraft(input)
    f.saveDraft.mockImplementationOnce(async () => { f.edit(fresh); f.source.source_message_id = '244'; return { written: true, message: fresh } })
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'unavailable' })
    expect(f.saveDraft).toHaveBeenLastCalledWith(expect.anything(), 77, '', fresh, true)
    expect(f.current()).toBe(''); expect(f.sendPrivateNote).not.toHaveBeenCalled()
  })
  it('requires a trusted source note and safe bounded IDs, rejecting supplied answer text', async () => {
    for (const action of ['draft_preview', 'draft_apply']) {
      expect(manualDraftRequestSchema.safeParse({ action, ...input }).success).toBe(true)
      expect(manualDraftRequestSchema.safeParse({ action, ...input, draft: 'injected' }).success).toBe(false)
      expect(manualDraftRequestSchema.safeParse({ action, ...input, generationId: 'bad' }).success).toBe(false)
    }
    const f = fixture(); f.query.mockResolvedValue({ rows: [] })
    await expect(f.service.previewDraft(input)).resolves.toEqual({ status: 'unavailable' })
    expect(f.brain.answer).not.toHaveBeenCalled()
  })
})


it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('validates exact original note identity and generation isolation in PostgreSQL', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query("CREATE TEMP TABLE conversations (id bigint, account_id bigint, display_id bigint, inbox_id integer, custom_attributes jsonb)")
    await client.query(`CREATE TEMP TABLE messages (id bigint, account_id bigint, conversation_id bigint, inbox_id bigint,
      message_type integer, private boolean, sender_type text, sender_id bigint, content text, content_attributes json,
      created_at timestamptz DEFAULT now(), additional_attributes jsonb DEFAULT '{}', content_type integer DEFAULT 0)`)
    await client.query("INSERT INTO conversations VALUES (9001,101,77,17,'{}')")
    await client.query(`INSERT INTO messages (id,account_id,conversation_id,inbox_id,message_type,private,sender_type,sender_id,content,content_attributes) VALUES
      (243,101,9001,17,0,false,'Contact',1,'Wie funktioniert das Konto?','{}'),
      (250,101,9001,17,1,true,'AgentBot',7,$1,'{"myinvest_agent_delivery_id":"243","myinvest_agent_message_kind":"draft_note"}')`, [`KI-Entwurf\n\nAntwortvorschlag:\n${old}\nQuellen: Hilfe`])
    const f = fixture()
    // Replace only the read port: all writes and Brain calls remain local fakes.
    const errors: unknown[] = []
    f.query.mockImplementation(async (sql: string, values: unknown[]) => {
      try { return await client.query(sql, values) } catch (error) { errors.push(error); throw error }
    })
    const result = await f.service.previewDraft(input)
    expect(errors).toEqual([])
    expect(result).toMatchObject({ status: 'preview' })
    for (const change of ["sender_id=8", "sender_type='User'", 'private=false', 'inbox_id=18', 'account_id=202']) {
      await client.query(`UPDATE messages SET ${change} WHERE id=250`)
      await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'unavailable' })
      await client.query("UPDATE messages SET sender_id=7,sender_type='AgentBot',private=true,inbox_id=17,account_id=101 WHERE id=250")
    }
    await client.query(`INSERT INTO messages (id,account_id,conversation_id,inbox_id,message_type,private,sender_type,sender_id,content,content_attributes)
      VALUES (251,101,9001,17,1,true,'AgentBot',7,'New generation',$1)`, [JSON.stringify({ myinvest_agent_delivery_id: '243', myinvest_agent_message_kind: 'draft_note', myinvest_agent_generation_id: 'b959abf5-7754-4eec-a281-52f619c30174' })])
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'unavailable' })
    await client.query('UPDATE messages SET content_attributes=$1 WHERE id=251', [JSON.stringify({ myinvest_agent_delivery_id: '243', myinvest_agent_message_kind: 'draft_note', myinvest_agent_generation_id: generationId })])
    await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'ready' })
    expect(f.saveDraft).toHaveBeenCalledOnce()
  } finally { await client.end() }
})

it('uses the database question timestamp for regeneration, never a browser supplied date', async () => {
  const f = fixture()
  Object.assign(f.source, { source_created_at: new Date('2026-08-01T08:30:00.000Z') })
  await expect(f.service.previewDraft(input)).resolves.toMatchObject({ status: 'preview' })
  expect(f.brain.answer).toHaveBeenCalledWith(expect.objectContaining({ questionReceivedAt: '2026-08-01T08:30:00.000Z' }), undefined)
  expect(f.query.mock.calls[0]?.[0]).toContain('incoming.created_at AS source_created_at')
  expect(manualDraftRequestSchema.safeParse({ action: 'draft_preview', ...input, questionReceivedAt: '2026-09-19T00:00:00.000Z' }).success).toBe(false)
})


it('routes only opted-in previews to Beta and applies the immutable result without another Brain call', async () => {
  const f = fixture(true)
  const preview = { ...input, brainTarget: 'beta' as const }
  await expect(f.service.previewDraft(preview)).resolves.toMatchObject({ status: 'preview', draft: 'Beta-Wissen' })
  await expect(f.service.previewDraft(input)).resolves.toMatchObject({ status: 'preview', draft: 'Beta-Wissen' })
  expect(f.betaBrain.answer).toHaveBeenCalledOnce()
  expect(f.brain.answer).not.toHaveBeenCalled()
  expect(f.betaBrain.answer).toHaveBeenCalledWith(expect.objectContaining({ reviewOnly: true, tenant: 'saas' }), undefined)
  await expect(f.service.applyDraft(input)).resolves.toEqual({ status: 'ready' })
  expect(f.saveDraft).toHaveBeenCalledWith(expect.anything(), 77, 'Beta-Wissen', old, true)
  expect(f.betaBrain.answer).toHaveBeenCalledOnce()
  const normal = fixture(true)
  await expect(normal.service.previewDraft(input)).resolves.toMatchObject({ status: 'preview', draft: fresh })
  expect(normal.brain.answer).toHaveBeenCalledOnce()
  expect(normal.betaBrain.answer).not.toHaveBeenCalled()
})

it('does not silently fall back to production if the Beta port is missing or fails', async () => {
  const missing = fixture()
  await expect(missing.service.previewDraft({ ...input, brainTarget: 'beta' })).resolves.toEqual({ status: 'unavailable' })
  expect(missing.brain.answer).not.toHaveBeenCalled()
  const failed = fixture(true)
  failed.betaBrain.answer.mockRejectedValue(new Error('Beta unavailable'))
  await expect(failed.service.previewDraft({ ...input, brainTarget: 'beta' })).resolves.toEqual({ status: 'unavailable' })
  expect(failed.betaBrain.answer).toHaveBeenCalledOnce()
  expect(failed.brain.answer).not.toHaveBeenCalled()
  expect(failed.proposals.save).not.toHaveBeenCalled()
})
