import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AudioTranscriptionClient } from '../src/audio-transcription.js'
import { activeStorageProxyUrl, inspectVoiceOgg, MAX_VOICE_BYTES } from '../src/audio-media.js'
import { ChatwootClient } from '../src/chatwoot-client.js'
import { MessageProcessor } from '../src/processor.js'
import { incomingPayload, PSEUDONYMIZATION_KEY, tenants } from './fixtures.js'

const voice = readFileSync(new URL('./fixtures/voice-clean.ogg', import.meta.url))
const tenant = tenants[0]!
const source = {
  executionContext: { accountId: 101, inboxId: 17, conversationId: 77, sourceMessageId: 55,
    contactId: 42, sourceChannel: 'whatsapp' as const,
    sourceReceivedAt: incomingPayload().created_at, mode: 'customer_message' as const },
  content: '', audioAttachment: { id: 29, byteSize: voice.length },
}

describe('WhatsApp voice media boundary', () => {
  it('accepts a real Ogg/Opus recording and rejects oversized, altered and long media', () => {
    expect(inspectVoiceOgg(voice)?.seconds).toBe(0.5)
    expect(inspectVoiceOgg(Buffer.alloc(MAX_VOICE_BYTES + 1))).toBeUndefined()
    const invalid = Buffer.from(voice)
    invalid.write('RIFF', 0)
    expect(inspectVoiceOgg(invalid)).toBeUndefined()
    const corrupt = Buffer.from(voice)
    corrupt[corrupt.length - 10] ^= 1
    expect(inspectVoiceOgg(corrupt)).toBeUndefined()
    const long = Buffer.from(voice)
    // The EOS granule is in the last page; alter it beyond 120 seconds.
    const lastPage = long.lastIndexOf(Buffer.from('OggS'))
    long.writeBigUInt64LE(121n * 48_000n, lastPage + 6)
    expect(inspectVoiceOgg(long)).toBeUndefined()
  })

  it('downloads only the exact DB-bound audio attachment through the same-origin proxy', async () => {
    const signed = 'https://support.example.test/rails/active_storage/blobs/redirect/signed-blob/voice.ogg?disposition=inline'
    const request = vi.fn(async (url: string | URL) => {
      const path = String(url)
      if (path.includes('/messages?')) return Response.json({ payload: [{ id: 55, message_type: 0, private: false,
        attachments: [{ id: 29, file_type: 'audio', file_size: voice.length,
          content_type: 'audio/ogg', data_url: signed }] }] })
      return new Response(voice, { headers: { 'content-length': String(voice.length) } })
    })
    const client = new ChatwootClient('http://rails:3000', { exists: vi.fn(async () => false) }, request as typeof fetch)
    expect(await client.loadVoiceAttachment(tenant, 77, 55, source.audioAttachment)).toEqual(voice)
    expect(String(request.mock.calls[0]![0])).toContain('messages?after=55&before=56')
    expect(String(request.mock.calls[1]![0])).toBe('http://rails:3000/rails/active_storage/blobs/proxy/signed-blob/voice.ogg?disposition=inline')
    expect(activeStorageProxyUrl('https://evil.test/rails/active_storage/blobs/redirect/%2fsecret/x.ogg', 'http://rails:3000')).toBeUndefined()
    expect(activeStorageProxyUrl('https://support.example.test/rails/active_storage/blobs/redirect/signed-blob/voice.ogg?redirect=https://evil.test', 'http://rails:3000')).toBeUndefined()
  })

  it('does not fetch bytes for a substituted attachment or redirected proxy response', async () => {
    const signed = 'https://support.example.test/rails/active_storage/blobs/redirect/signed-blob/voice.ogg'
    const request = vi.fn(async (url: string | URL) => String(url).includes('/messages?')
      ? Response.json({ payload: [{ id: 55, message_type: 0, private: false,
        attachments: [{ id: 30, file_type: 'audio', file_size: voice.length,
          content_type: 'audio/ogg', data_url: signed }] }] })
      : Response.redirect('https://outside.example.test/blob'))
    const client = new ChatwootClient('http://rails:3000', { exists: vi.fn(async () => false) }, request as typeof fetch)
    expect(await client.loadVoiceAttachment(tenant, 77, 55, source.audioAttachment)).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
    const redirectRequest = vi.fn(async (url: string | URL, _init?: RequestInit) => String(url).includes('/messages?')
      ? Response.json({ payload: [{ id: 55, message_type: 0, private: false,
        attachments: [{ id: 29, file_type: 'audio', file_size: voice.length,
          content_type: 'audio/ogg', data_url: signed }] }] })
      : Response.redirect('https://outside.example.test/blob'))
    const redirectClient = new ChatwootClient('http://rails:3000', { exists: vi.fn(async () => false) }, redirectRequest as typeof fetch)
    expect(await redirectClient.loadVoiceAttachment(tenant, 77, 55, source.audioAttachment)).toBeUndefined()
    expect(redirectRequest.mock.calls[1]![1]).toMatchObject({ redirect: 'error' })
  })

  it('fails closed on infected or unavailable scans and bounds remote calls', async () => {
    const request = vi.fn()
    const client = new AudioTranscriptionClient({ answerUrl: 'https://beta.example.test/api/support/answer',
      secret: 'test-secret-with-more-than-thirty-two-bytes', clamavHost: 'clamav', enabled: true,
      scan: vi.fn(async () => 'infected' as const), request })
    expect(await client.transcribe({ bytes: voice, requestId: 'audio:test:29', accountId: 101,
      inboxId: 17, conversationId: 77, sourceMessageId: 55, attachmentId: 29 })).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
})

function processorFixture(transcript: string | undefined) {
  const answer = vi.fn()
  const sendMessage = vi.fn()
  const saveDraft = vi.fn(async (_tenant: unknown, _id: number, text: string) => ({ written: true, message: text }))
  const sendPrivateNote = vi.fn(async () => undefined)
  const transcribe = vi.fn(async () => transcript)
  const loadCurrentSource = vi.fn(async () => source)
  const state = {
    isHandedOff: vi.fn(async () => false), activateConversation: vi.fn(async () => undefined),
    beginDelivery: vi.fn().mockResolvedValueOnce({ acquired: true, status: 'processing' })
      .mockResolvedValue({ acquired: false, status: 'handed_off' }),
    completeHandoff: vi.fn(async () => undefined), completeWithoutReply: vi.fn(async () => undefined),
    markSending: vi.fn(async () => undefined), completeReply: vi.fn(async () => undefined),
    failDelivery: vi.fn(async () => undefined),
  }
  const processor = new MessageProcessor({
    brain: { answer }, audio: { transcribe },
    chatwoot: { loadVoiceAttachment: vi.fn(async () => voice), sendMessage, saveDraft,
      sendPrivateNote, setPriority: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined), assign: vi.fn(async () => undefined),
      handoff: vi.fn(async () => undefined) },
    context: { loadContext: vi.fn(async () => ({ turns: [], labels: [],
      humanEverReplied: false, humanRepliedAfterBot: false,
      supportRouting: { conversationTenant: 'saas', conversationChannel: 'whatsapp', sourceTenant: 'saas' } })),
      loadCurrentSource },
    state,
    autoSend: { blockConversation: vi.fn(async () => undefined), reserve: vi.fn(), markSent: vi.fn() },
    conversationLock: { runExclusive: async <T>(_key: never, _id: number, operation: () => Promise<T>) => operation() },
    pseudonymizationKey: PSEUDONYMIZATION_KEY, autoSendEnabled: true,
    autoSendLimits: { maxPerConversation: 3, maxPerContactPerHour: 10 },
    whatsappInboxIds: new Set([17]),
  } as ConstructorParameters<typeof MessageProcessor>[0])
  return { processor, answer, sendMessage, saveDraft, sendPrivateNote, transcribe, loadCurrentSource, state }
}

describe('WhatsApp audio review', () => {
  it('creates only a marked internal draft and does not repeat on duplicate delivery', async () => {
    const flow = processorFixture('Bitte überweise 500 Euro.')
    const payload = incomingPayload({ content: '' })
    await flow.processor.process({ tenant, payload })
    await flow.processor.process({ tenant, payload })
    expect(flow.transcribe).toHaveBeenCalledTimes(1)
    expect(flow.saveDraft).toHaveBeenCalledWith(tenant, 77, expect.stringContaining('Transkript ist unbestätigt'))
    expect(flow.saveDraft.mock.calls[0]![2]).toContain('bestätigen, bevor eine sensible Aktion erfolgt')
    expect(flow.sendPrivateNote).toHaveBeenCalledTimes(1)
    expect(flow.sendPrivateNote.mock.calls[0]![2]).toContain('quellengebundenes Audio-Transkript')
    expect(flow.answer).not.toHaveBeenCalled()
    expect(flow.sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to manual media review when transcription fails', async () => {
    const flow = processorFixture(undefined)
    await flow.processor.process({ tenant, payload: incomingPayload({ content: '' }) })
    expect(flow.saveDraft.mock.calls[0]![2]).toContain('konnte nicht sicher transkribiert werden')
    expect(flow.sendMessage).not.toHaveBeenCalled()
  })

  it('drops a transcript if the customer source changes while it is processed', async () => {
    const flow = processorFixture('Bitte überweise 500 Euro.')
    flow.loadCurrentSource.mockResolvedValueOnce(source).mockResolvedValueOnce(undefined)
    await flow.processor.process({ tenant, payload: incomingPayload({ content: '' }) })
    expect(flow.state.completeWithoutReply).toHaveBeenCalledWith('saas', 55)
    expect(flow.saveDraft).not.toHaveBeenCalled()
    expect(flow.sendMessage).not.toHaveBeenCalled()
  })
})
